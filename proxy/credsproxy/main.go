// credsproxy: the credential boundary between agent code and the Anthropic API.
//
// Agent-side processes (the kernel, and any subagent it spawns through jobs)
// never hold the real API key. They get two env vars:
//
//	ANTHROPIC_BASE_URL = http://<proxy-host>:<port>
//	ANTHROPIC_API_KEY  = <opaque per-session token minted by this proxy>
//
// The proxy validates the token, swaps in the real key, forwards to the real
// API and streams the response back. That is the whole job. Deliberately NOT
// here: TLS interception, allow/deny policy for arbitrary hosts, LLM judging —
// that is the open-egress layer (crabtrap) and it composes as a parent proxy
// without touching this one. Two trust boundaries, two components: this one
// holds secrets and stays small enough to audit by reading it.
//
// Enforcement that nothing bypasses this proxy is the sandbox's network config
// (srt: deny all egress except the proxy hosts), not code in this file.
//
// Every request is audited to JSONL — session name, method, path, status,
// bytes, duration — never the key and never the body. Log the inputs, not just
// the verdicts: the audit line is written even when the verdict is a 401.
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
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// A session token is opaque and maps to a name used only for auditing. Tokens
// are minted host-side (--mint) before the sandbox starts and passed in via its
// environment; there is deliberately no mint-over-HTTP endpoint an agent could
// reach.
type sessions struct {
	mu     sync.RWMutex
	byTok  map[string]string // token -> session name
	spends map[string]int64  // session name -> upstream requests served
}

func (s *sessions) lookup(tok string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	// Constant-time compare against each stored token: the map's own hashing
	// short-circuits on inequality, which leaks nothing useful for a random
	// 128-bit token, but the explicit loop costs nothing at our session counts
	// and removes the question entirely.
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

type auditLine struct {
	TS          string `json:"ts"`
	Session     string `json:"session"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Status      int    `json:"status"`
	Bytes       int64  `json:"bytes"`
	Millis      int64  `json:"ms"`
	Verdict     string `json:"verdict"` // forwarded | bad_token | no_token
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

// statusRecorder exists because the audit line needs the status and byte count
// after ReverseProxy has streamed the response through.
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

// Flush must be forwarded or SSE streaming (every model response) degrades to
// one flush at EOF, which turns a 60s stream into a 60s stall.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Session name rides the request via a header that is set after auth, read by
// the error handler, and stripped in Rewrite so it is never sent upstream.
const sessionHeader = "X-Credsproxy-Session"

func setSessionName(r *http.Request, name string) { r.Header.Set(sessionHeader, name) }
func sessionName(r *http.Request) string {
	if v := r.Header.Get(sessionHeader); v != "" {
		return v
	}
	return "-"
}

func newReverseProxy(up *url.URL, realKey string, aud *auditor) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(up)
			pr.Out.Host = up.Host
			// The swap. x-api-key is what the SDKs send; Authorization covers
			// hand-rolled clients. Both are replaced, never forwarded.
			pr.Out.Header.Set("x-api-key", realKey)
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del(sessionHeader)
		},
		FlushInterval: -1, // stream every write immediately (SSE)
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			aud.write(auditLine{Session: sessionName(r), Method: r.Method, Path: r.URL.Path,
				Status: http.StatusBadGateway, Verdict: "forwarded", UpstreamErr: err.Error()})
			http.Error(w, "upstream error", http.StatusBadGateway)
		},
	}
}

func newHandler(sess *sessions, aud *auditor, rp http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		tok := r.Header.Get("x-api-key")
		if tok == "" {
			tok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
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
		setSessionName(r, name)
		sess.count(name)
		rec := &statusRecorder{ResponseWriter: w}
		rp.ServeHTTP(rec, r)
		aud.write(auditLine{Session: name, Method: r.Method, Path: r.URL.Path,
			Status: rec.status, Bytes: rec.bytes, Verdict: "forwarded", Millis: time.Since(start).Milliseconds()})
	})
}

func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("mint: %v", err)
	}
	return "cpx-" + hex.EncodeToString(b)
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8091", "address to listen on")
	upstream := flag.String("upstream", "https://api.anthropic.com", "real API base URL")
	auditPath := flag.String("audit", "", "JSONL audit file (default: stderr)")
	tokensPath := flag.String("tokens", "", "file of '<name> <token>' lines minted with --mint")
	mint := flag.String("mint", "", "mint a token for the named session, print 'name token', exit")
	flag.Parse()

	if *mint != "" {
		fmt.Printf("%s %s\n", *mint, newToken())
		return
	}

	realKey := os.Getenv("CREDSPROXY_UPSTREAM_KEY")
	if realKey == "" {
		log.Fatal("CREDSPROXY_UPSTREAM_KEY is not set; refusing to start a proxy that would forward unauthenticated")
	}
	up, err := url.Parse(*upstream)
	if err != nil {
		log.Fatalf("bad --upstream: %v", err)
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

	aud := &auditor{out: os.Stderr}
	if *auditPath != "" {
		f, err := os.OpenFile(*auditPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			log.Fatalf("open --audit: %v", err)
		}
		aud.out = f
	}

	rp := newReverseProxy(up, realKey, aud)
	log.Printf("credsproxy listening on %s -> %s (%d session(s))", *listen, up, len(sess.byTok))
	log.Fatal(http.ListenAndServe(*listen, newHandler(sess, aud, rp)))
}
