// egress: the single network route out of the sandbox.
//
// Everything agent code may reach is a ROUTE in this proxy's table — any API we
// choose to expose, not just MCP. Each route maps a path prefix to an upstream
// and injects that upstream's credentials at the boundary, so no credential of
// any kind exists sandbox-side. Sandbox processes get two env vars:
//
//	HARNESS_EGRESS_PROXY  = http://<host>:<port>
//	HARNESS_EGRESS_TOKEN  = <opaque per-session token minted host-side>
//
// and the sandbox's network config (srt) denies everything except this address.
//
// Requests look like: POST {proxy}/r/<route>/<upstream-path>, token in
// x-egress-token (or x-api-key / Authorization, so unmodified SDKs pointed at
// {proxy}/r/<route> work as-is).
//
// The control surface is part of the same boundary: POST /control/spawn turns
// "start a subagent" into an API call like everything else. The proxy runs
// harness-side where the jobs directory lives, so it writes the request file
// the broker (runtime/subagent_broker.py) already services — API call as the
// transport, files as the durability log. The exactly-once story is unchanged.
//
// Deliberately NOT here: TLS interception, allow/deny policy for arbitrary
// hosts, LLM judging — that is the open-egress layer (crabtrap) and it composes
// as a parent without touching this one. This component holds secrets and stays
// small enough to audit by reading it.
//
// Every request is audited to JSONL — session, route, method, path, status,
// bytes, duration — never a credential and never a body.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---- config ----------------------------------------------------------------

// A route exposes one upstream. Credentials come from the named env var on the
// PROXY's side (never inline in the config file, which gets committed and
// copied around; the env var is read once at startup).
type routeConfig struct {
	Name        string   `json:"name"`          // path segment: /r/<name>/...
	Upstream    string   `json:"upstream"`      // e.g. https://api.anthropic.com
	CredHeader  string   `json:"cred_header"`   // header to set, e.g. x-api-key or Authorization
	CredEnv     string   `json:"cred_env"`      // env var holding the credential
	CredPrefix  string   `json:"cred_prefix"`   // optional, e.g. "Bearer "
	StripHeader []string `json:"strip_headers"` // extra client headers to drop
}

type config struct {
	Routes []routeConfig `json:"routes"`
	// SpawnDir, when set, enables POST /control/spawn: the body is written as a
	// subagent request file the broker services. Empty disables the endpoint.
	SpawnDir string `json:"spawn_dir"`
}

type route struct {
	cfg   routeConfig
	cred  string
	proxy *httputil.ReverseProxy
}

// ---- sessions ---------------------------------------------------------------

type sessions struct {
	mu     sync.RWMutex
	byTok  map[string]string // token -> session name
	spends map[string]int64
}

func (s *sessions) lookup(tok string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for stored, name := range s.byTok {
		if subtle.ConstantTimeCompare([]byte(stored), []byte(tok)) == 1 {
			return name, true
		}
	}
	return "", false
}

func (s *sessions) count(name string) {
	s.mu.Lock()
	s.spends[name]++
	s.mu.Unlock()
}

// ---- audit ------------------------------------------------------------------

type auditLine struct {
	TS          string `json:"ts"`
	Session     string `json:"session"`
	Route       string `json:"route"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Status      int    `json:"status"`
	Bytes       int64  `json:"bytes"`
	Millis      int64  `json:"ms"`
	Verdict     string `json:"verdict"` // forwarded | no_token | bad_token | no_route | spawn | spawn_rejected
	UpstreamErr string `json:"upstream_err,omitempty"`
}

type auditor struct {
	mu  sync.Mutex
	out io.Writer
}

func (a *auditor) write(l auditLine) {
	l.TS = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(l)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.out.Write(append(b, '\n'))
}

// ---- response recording -----------------------------------------------------

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

// Flush must be forwarded or SSE streaming degrades to one flush at EOF.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ---- routes -----------------------------------------------------------------

// Model providers, which this proxy will not route to. The principle is the
// architecture's (docs/CLOUD-HARNESS-DESIGN.md): intelligence enters the
// sandbox as `spawn()` — a subagent the harness starts, whose turns and cost
// belong to a job record and whose trace is collected — and never as a raw
// provider call from a cell, which would sit outside the budget caps and
// outside the trace while looking like ordinary egress in the audit log.
//
// A route is the only way anything reaches the network from the sandbox, so
// refusing it here is the whole enforcement. It is a startup error rather than
// a runtime 403: a config that thinks it exposes a provider must not come up
// half-working, and the operator who wrote it should hear about it once.
var providerHosts = []string{"anthropic.com", "openai.com", "googleapis.com"}

func isProviderHost(host string) bool {
	host = strings.ToLower(host)
	for _, p := range providerHosts {
		if host == p || strings.HasSuffix(host, "."+p) {
			return true
		}
	}
	return false
}

func buildRoute(cfg routeConfig, aud *auditor) (*route, error) {
	up, err := url.Parse(cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("route %s: bad upstream: %w", cfg.Name, err)
	}
	if isProviderHost(up.Hostname()) {
		return nil, fmt.Errorf(
			"route %s: refusing to route to the model provider %s. Intelligence reaches the "+
				"sandbox as spawn() — a subagent the harness starts, budgeted and traced — not as a "+
				"provider call from a cell, which would bypass both",
			cfg.Name, up.Hostname())
	}
	cred := os.Getenv(cfg.CredEnv)
	if cfg.CredEnv != "" && cred == "" {
		return nil, fmt.Errorf("route %s: env %s is empty; refusing to forward unauthenticated", cfg.Name, cfg.CredEnv)
	}
	r := &route{cfg: cfg, cred: cred}
	prefix := "/r/" + cfg.Name
	r.proxy = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(up)
			pr.Out.Host = up.Host
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, prefix)
			if pr.Out.URL.Path == "" {
				pr.Out.URL.Path = "/"
			}
			// Client-side auth headers never travel upstream, whatever they held.
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("x-api-key")
			pr.Out.Header.Del(egressTokenHeader)
			pr.Out.Header.Del(sessionHeader)
			for _, h := range cfg.StripHeader {
				pr.Out.Header.Del(h)
			}
			if cfg.CredHeader != "" && r.cred != "" {
				pr.Out.Header.Set(cfg.CredHeader, cfg.CredPrefix+r.cred)
			}
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
			aud.write(auditLine{Session: sessionName(req), Route: cfg.Name, Method: req.Method,
				Path: req.URL.Path, Status: http.StatusBadGateway, Verdict: "forwarded", UpstreamErr: err.Error()})
			http.Error(w, "upstream error", http.StatusBadGateway)
		},
	}
	return r, nil
}

// ---- spawn control ----------------------------------------------------------

// Job names must match the broker's expectations; the @ separator is reserved
// for broker bookkeeping (see runtime/subagent_broker.py).
var jobNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

type spawnRequest struct {
	Name string          `json:"name"`
	Body json.RawMessage `json:"body"` // opaque to the proxy; the broker owns the schema
}

// handleSpawn writes the request file the broker services. Write-to-temp then
// rename, so the broker can never observe a half-written request.
func handleSpawn(spawnDir string, aud *auditor, session string, w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	reject := func(status int, msg string) {
		aud.write(auditLine{Session: session, Route: "control", Method: r.Method, Path: r.URL.Path,
			Status: status, Verdict: "spawn_rejected", Millis: time.Since(start).Milliseconds()})
		http.Error(w, msg, status)
	}
	if r.Method != http.MethodPost {
		reject(http.StatusMethodNotAllowed, "POST only")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		reject(http.StatusBadRequest, "unreadable body")
		return
	}
	var req spawnRequest
	if err := json.Unmarshal(body, &req); err != nil || !jobNameRe.MatchString(req.Name) || len(req.Body) == 0 {
		reject(http.StatusBadRequest, "want {name: <job-name>, body: <request>}")
		return
	}
	final := filepath.Join(spawnDir, req.Name+".json")
	if _, err := os.Stat(final); err == nil {
		// Idempotent by name: a retried POST after a lost response must not
		// double-spawn. Same rule as the broker's exactly-once claim.
		aud.write(auditLine{Session: session, Route: "control", Method: r.Method, Path: r.URL.Path,
			Status: http.StatusOK, Verdict: "spawn", Millis: time.Since(start).Milliseconds()})
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"name":%q,"status":"already_requested"}`, req.Name)
		return
	}
	tmp, err := os.CreateTemp(spawnDir, ".spawn-*")
	if err != nil {
		reject(http.StatusInternalServerError, "spawn dir unwritable")
		return
	}
	if _, err := tmp.Write(req.Body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		reject(http.StatusInternalServerError, "write failed")
		return
	}
	tmp.Sync()
	tmp.Close()
	if err := os.Rename(tmp.Name(), final); err != nil {
		os.Remove(tmp.Name())
		reject(http.StatusInternalServerError, "rename failed")
		return
	}
	aud.write(auditLine{Session: session, Route: "control", Method: r.Method, Path: r.URL.Path,
		Status: http.StatusCreated, Verdict: "spawn", Millis: time.Since(start).Milliseconds()})
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, `{"name":%q,"status":"requested"}`, req.Name)
}

// ---- handler ----------------------------------------------------------------

const (
	egressTokenHeader = "x-egress-token"
	sessionHeader     = "X-Egress-Session" // internal; set after auth, stripped in Rewrite
)

func setSessionName(r *http.Request, name string) { r.Header.Set(sessionHeader, name) }
func sessionName(r *http.Request) string {
	if v := r.Header.Get(sessionHeader); v != "" {
		return v
	}
	return "-"
}

func clientToken(r *http.Request) string {
	if v := r.Header.Get(egressTokenHeader); v != "" {
		return v
	}
	if v := r.Header.Get("x-api-key"); v != "" {
		return v
	}
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func newHandler(sess *sessions, aud *auditor, routes map[string]*route, spawnDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		tok := clientToken(r)
		if tok == "" {
			aud.write(auditLine{Session: "-", Method: r.Method, Path: r.URL.Path,
				Status: http.StatusUnauthorized, Verdict: "no_token", Millis: time.Since(start).Milliseconds()})
			http.Error(w, "missing session token", http.StatusUnauthorized)
			return
		}
		name, ok := sess.lookup(tok)
		if !ok {
			aud.write(auditLine{Session: "-", Method: r.Method, Path: r.URL.Path,
				Status: http.StatusUnauthorized, Verdict: "bad_token", Millis: time.Since(start).Milliseconds()})
			http.Error(w, "unknown session token", http.StatusUnauthorized)
			return
		}
		sess.count(name)

		if r.URL.Path == "/control/spawn" {
			if spawnDir == "" {
				aud.write(auditLine{Session: name, Route: "control", Method: r.Method, Path: r.URL.Path,
					Status: http.StatusNotFound, Verdict: "spawn_rejected", Millis: time.Since(start).Milliseconds()})
				http.Error(w, "spawn not enabled", http.StatusNotFound)
				return
			}
			handleSpawn(spawnDir, aud, name, w, r)
			return
		}

		// /r/<route>/<rest>
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 3)
		if len(parts) < 2 || parts[0] != "r" {
			aud.write(auditLine{Session: name, Method: r.Method, Path: r.URL.Path,
				Status: http.StatusNotFound, Verdict: "no_route", Millis: time.Since(start).Milliseconds()})
			http.Error(w, "no such route", http.StatusNotFound)
			return
		}
		rt, ok := routes[parts[1]]
		if !ok {
			aud.write(auditLine{Session: name, Route: parts[1], Method: r.Method, Path: r.URL.Path,
				Status: http.StatusNotFound, Verdict: "no_route", Millis: time.Since(start).Milliseconds()})
			http.Error(w, "no such route", http.StatusNotFound)
			return
		}
		setSessionName(r, name)
		rec := &statusRecorder{ResponseWriter: w}
		rt.proxy.ServeHTTP(rec, r)
		aud.write(auditLine{Session: name, Route: rt.cfg.Name, Method: r.Method, Path: r.URL.Path,
			Status: rec.status, Bytes: rec.bytes, Verdict: "forwarded", Millis: time.Since(start).Milliseconds()})
	})
}

// ---- main -------------------------------------------------------------------

// listenAndAnnounce binds, then publishes the address it actually got.
//
// A per-run proxy asks for port 0: a fixed port collides the moment two runs
// overlap, and this harness pools benchmark tasks. But the kernel needs the
// resolved port in its environment before it boots, so the port has to travel
// back to the parent — hence a file, written temp-then-rename so a parent
// polling for it can never read half an address and dial a truncated port.
func listenAndAnnounce(addr, addrFile string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	if addrFile == "" {
		return ln, nil
	}
	tmp := addrFile + ".writing"
	if err := os.WriteFile(tmp, []byte(ln.Addr().String()), 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("write --addr-file: %w", err)
	}
	if err := os.Rename(tmp, addrFile); err != nil {
		ln.Close()
		return nil, fmt.Errorf("rename --addr-file: %w", err)
	}
	return ln, nil
}

func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("mint: %v", err)
	}
	return "egr-" + hex.EncodeToString(b)
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8091", "address to listen on (port 0 picks a free one)")
	addrFile := flag.String("addr-file", "", "write the bound address here once listening")
	configPath := flag.String("config", "", "route table JSON (required)")
	auditPath := flag.String("audit", "", "JSONL audit file (default: stderr)")
	tokensPath := flag.String("tokens", "", "file of '<name> <token>' lines minted with --mint")
	mint := flag.String("mint", "", "mint a token for the named session, print 'name token', exit")
	flag.Parse()

	if *mint != "" {
		fmt.Printf("%s %s\n", *mint, newToken())
		return
	}

	raw, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read --config: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		log.Fatalf("parse --config: %v", err)
	}
	// Zero routes is a legitimate configuration — the eval loop runs the proxy
	// purely for /control/spawn, and "the sandbox reaches nothing off-box" is
	// exactly the posture those tasks are measured under. Zero of BOTH is not:
	// it comes up, authenticates, and 404s everything, which reads as a working
	// boundary until someone notices nothing ever crossed it.
	if len(cfg.Routes) == 0 && cfg.SpawnDir == "" {
		log.Fatal("config exposes nothing: no routes and no spawn_dir")
	}

	aud := &auditor{out: os.Stderr}
	if *auditPath != "" {
		f, err := os.OpenFile(*auditPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			log.Fatalf("open --audit: %v", err)
		}
		aud.out = f
	}

	routes := map[string]*route{}
	for _, rc := range cfg.Routes {
		rt, err := buildRoute(rc, aud)
		if err != nil {
			log.Fatal(err)
		}
		routes[rc.Name] = rt
	}
	if cfg.SpawnDir != "" {
		if err := os.MkdirAll(cfg.SpawnDir, 0o755); err != nil {
			log.Fatalf("spawn dir: %v", err)
		}
	}

	sess := &sessions{byTok: map[string]string{}, spends: map[string]int64{}}
	if *tokensPath != "" {
		raw, err := os.ReadFile(*tokensPath)
		if err != nil {
			log.Fatalf("read --tokens: %v", err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 2 {
				sess.byTok[fields[1]] = fields[0]
			}
		}
	}
	if len(sess.byTok) == 0 {
		log.Fatal("no session tokens loaded; mint with --mint and pass --tokens")
	}

	ln, err := listenAndAnnounce(*listen, *addrFile)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("egress listening on %s: %d route(s), spawn=%v, %d session(s)",
		ln.Addr(), len(routes), cfg.SpawnDir != "", len(sess.byTok))
	log.Fatal(http.Serve(ln, newHandler(sess, aud, routes, cfg.SpawnDir)))
}
