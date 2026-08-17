package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	realKey = "sk-real-CRED"
	goodTok = "egr-deadbeef"
)

// buildHandler wires the same constructors main() uses, against a fake upstream.
func buildHandler(t *testing.T, upstreamURL, spawnDir string) http.Handler {
	t.Helper()
	t.Setenv("TEST_ROUTE_CRED", realKey)
	rc := routeConfig{Name: "svc", Upstream: upstreamURL, CredHeader: "x-api-key", CredEnv: "TEST_ROUTE_CRED"}
	aud := &auditor{out: io.Discard}
	rt, err := buildRoute(rc, aud)
	if err != nil {
		t.Fatal(err)
	}
	sess := &sessions{byTok: map[string]string{goodTok: "task-42"}, spends: map[string]int64{}}
	return newHandler(sess, aud, map[string]*route{"svc": rt}, spawnDir)
}

func buildServer(t *testing.T, upstreamURL, spawnDir string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(buildHandler(t, upstreamURL, spawnDir))
}

// tempSocket returns a short-enough socket path. Deliberately not t.TempDir():
// on macOS that is /var/folders/<2>/<26>/T/<TestName>/001, which for a test name
// of any length blows past the 104-byte sun_path ceiling — the exact trap
// listenUnixSocket reports on, and one a test must not walk into by accident.
func tempSocket(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "egr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "e.sock")
}

// unixClient dials one socket for every request, whatever the URL's host says.
// This is the client shape a sandboxed caller needs (runtime/jobs.py does the
// same thing with http.client), so the tests exercise the real access pattern.
func unixClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
	}}
}

// serve runs the handler on already-bound listeners for the length of the test.
func serve(t *testing.T, h http.Handler, lns []net.Listener) {
	t.Helper()
	srv := &http.Server{Handler: h}
	for _, ln := range lns {
		go func(ln net.Listener) { srv.Serve(ln) }(ln)
	}
	t.Cleanup(func() { srv.Close() })
}

func TestRouteSwapAndStrip(t *testing.T) {
	var got http.Header
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		gotPath = r.URL.Path
		io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	srv := buildServer(t, upstream.URL, "")
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/r/svc/v1/messages", strings.NewReader(`{}`))
	req.Header.Set(egressTokenHeader, goodTok)
	req.Header.Set("Authorization", "Bearer client-junk")
	req.Header.Set("x-api-key", "client-junk-2")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != `{"ok":true}` {
		t.Fatalf("proxying broke the response: %d %q", resp.StatusCode, body)
	}
	if gotPath != "/v1/messages" {
		t.Fatalf("route prefix not stripped: upstream saw %q", gotPath)
	}
	if got.Get("x-api-key") != realKey {
		t.Fatalf("upstream saw x-api-key=%q, want the route credential", got.Get("x-api-key"))
	}
	for _, h := range []string{"Authorization", egressTokenHeader, sessionHeader} {
		if got.Get(h) != "" {
			t.Fatalf("client header %s leaked upstream: %q", h, got.Get(h))
		}
	}
	for k, vs := range got {
		for _, v := range vs {
			if strings.Contains(v, goodTok) {
				t.Fatalf("session token leaked upstream in header %s=%q", k, v)
			}
		}
	}
}

func TestAuthGate(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer upstream.Close()
	srv := buildServer(t, upstream.URL, "")
	defer srv.Close()

	for _, tok := range []string{"", "egr-wrong", realKey} { // the route credential is NOT a client token
		req, _ := http.NewRequest("POST", srv.URL+"/r/svc/v1/x", strings.NewReader(`{}`))
		if tok != "" {
			req.Header.Set(egressTokenHeader, tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q: got %d, want 401", tok, resp.StatusCode)
		}
	}
	if hits != 0 {
		t.Fatalf("upstream reached %d time(s) unauthenticated", hits)
	}
}

func TestUnknownRoute404s(t *testing.T) {
	srv := buildServer(t, "http://127.0.0.1:1", "") // upstream never dialed
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/r/nope/v1/x", nil)
	req.Header.Set(egressTokenHeader, goodTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown route: got %d, want 404", resp.StatusCode)
	}
}

func TestSDKCompatTokenForms(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	srv := buildServer(t, upstream.URL, "")
	defer srv.Close()

	// An unmodified SDK pointed at {proxy}/r/svc sends the token as x-api-key
	// or Authorization; both must authenticate.
	for _, set := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("x-api-key", goodTok) },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+goodTok) },
	} {
		req, _ := http.NewRequest("GET", srv.URL+"/r/svc/v1/models", nil)
		set(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("SDK-form token rejected: %d", resp.StatusCode)
		}
	}
}

func TestSpawnWritesRequestFileIdempotently(t *testing.T) {
	dir := t.TempDir()
	srv := buildServer(t, "http://127.0.0.1:1", dir)
	defer srv.Close()

	post := func(body string) (*http.Response, string) {
		req, _ := http.NewRequest("POST", srv.URL+"/control/spawn", strings.NewReader(body))
		req.Header.Set(egressTokenHeader, goodTok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	payload := `{"name":"reader","body":{"prompt":"find the word","tools":"read,grep"}}`
	resp, body := post(payload)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first spawn: got %d %s", resp.StatusCode, body)
	}
	written, err := os.ReadFile(filepath.Join(dir, "reader.json"))
	if err != nil {
		t.Fatal(err)
	}
	var round map[string]any
	if err := json.Unmarshal(written, &round); err != nil || round["prompt"] != "find the word" {
		t.Fatalf("request file is not the body verbatim: %s", written)
	}

	// A retried POST (lost response) must not double-spawn: same name -> 200
	// already_requested, file untouched.
	resp2, body2 := post(payload)
	if resp2.StatusCode != http.StatusOK || !strings.Contains(body2, "already_requested") {
		t.Fatalf("retry: got %d %s, want 200 already_requested", resp2.StatusCode, body2)
	}

	// No half-written files: nothing but reader.json in the dir.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("spawn dir has %d entries, want 1", len(entries))
	}
}

func TestSpawnRejectsBadNames(t *testing.T) {
	dir := t.TempDir()
	srv := buildServer(t, "http://127.0.0.1:1", dir)
	defer srv.Close()

	// @ is broker bookkeeping; path traversal must obviously die too.
	for _, name := range []string{"x@claim-1", "../escape", "a/b", ""} {
		b, _ := json.Marshal(map[string]any{"name": name, "body": map[string]any{"p": 1}})
		req, _ := http.NewRequest("POST", srv.URL+"/control/spawn", strings.NewReader(string(b)))
		req.Header.Set(egressTokenHeader, goodTok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("name %q: got %d, want 400", name, resp.StatusCode)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("rejected spawns left %d files", len(entries))
	}
}

// The eval loop's configuration: spawn and nothing else. Zero routes is the
// point there — those tasks are measured under "the sandbox reaches nothing
// off-box" — so the control surface has to work with an empty route table
// rather than requiring a decorative route to bring the proxy up.
func TestSpawnOnlyWithZeroRoutes(t *testing.T) {
	dir := t.TempDir()
	aud := &auditor{out: io.Discard}
	sess := &sessions{byTok: map[string]string{goodTok: "eval"}, spends: map[string]int64{}}
	srv := httptest.NewServer(newHandler(sess, aud, map[string]*route{}, dir))
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/control/spawn",
		strings.NewReader(`{"name":"child","body":{"cmd":"echo hi"}}`))
	req.Header.Set(egressTokenHeader, goodTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("spawn with no routes: got %d, want 201", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "child.json")); err != nil {
		t.Fatalf("request file not written: %v", err)
	}

	// And with no routes, every /r/ path is still a 404 rather than a panic on
	// the nil map.
	req2, _ := http.NewRequest("GET", srv.URL+"/r/anything/x", nil)
	req2.Header.Set(egressTokenHeader, goodTok)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("route lookup with empty table: got %d, want 404", resp2.StatusCode)
	}
}

// The whole boundary over a unix socket, not merely "the socket answers".
//
// This is the form Linux forces (bwrap gives the sandbox its own network
// namespace, so the harness's loopback is unreachable — docs §7.2), so the
// properties that make the TCP door a boundary have to hold on this one too:
// auth before anything, the route's credential swapped in, spawn writing its
// request file. A socket that accepted everything would look identical from
// outside.
func TestUnixSocketServesTheWholeBoundary(t *testing.T) {
	var gotKey, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath = r.Header.Get("x-api-key"), r.URL.Path
		io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	sock, spawnDir := tempSocket(t), t.TempDir()
	lns, err := openListeners("", sock, "")
	if err != nil {
		t.Fatal(err)
	}
	serve(t, buildHandler(t, upstream.URL, spawnDir), lns)
	cli := unixClient(sock)

	post := func(path, token, body string) (int, string) {
		req, _ := http.NewRequest("POST", "http://egress"+path, strings.NewReader(body))
		if token != "" {
			req.Header.Set(egressTokenHeader, token)
		}
		resp, err := cli.Do(req)
		if err != nil {
			t.Fatalf("POST %s over the socket: %v", path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}

	if status, body := post("/r/svc/v1/messages", goodTok, `{}`); status != 200 || body != `{"ok":true}` {
		t.Fatalf("route over the socket: %d %q", status, body)
	}
	if gotPath != "/v1/messages" || gotKey != realKey {
		t.Fatalf("upstream saw path=%q key=%q; the route did not swap the credential", gotPath, gotKey)
	}
	if status, _ := post("/control/spawn", goodTok, `{"name":"child","body":{"cmd":"echo hi"}}`); status != http.StatusCreated {
		t.Fatalf("spawn over the socket: %d, want 201", status)
	}
	if _, err := os.Stat(filepath.Join(spawnDir, "child.json")); err != nil {
		t.Fatalf("spawn over the socket wrote no request file: %v", err)
	}
	// The socket is not an authenticated channel by virtue of being a socket.
	for _, tok := range []string{"", "egr-wrong", realKey} {
		if status, _ := post("/control/spawn", tok, `{"name":"sneak","body":{"cmd":"x"}}`); status != http.StatusUnauthorized {
			t.Fatalf("token %q over the socket: %d, want 401", tok, status)
		}
	}
	if _, err := os.Stat(filepath.Join(spawnDir, "sneak.json")); err == nil {
		t.Fatal("an unauthenticated POST over the socket wrote a request file")
	}
	if status, _ := post("/r/nope/x", goodTok, ""); status != http.StatusNotFound {
		t.Fatalf("unknown route over the socket: %d, want 404", status)
	}

	// Only this uid may connect where the kernel enforces socket modes.
	st, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("socket mode is %o, want 600", perm)
	}
}

// SIGKILL is how the harness reaps a per-run proxy, and a killed process never
// unlinks its socket. So the NORMAL state of a reused run directory is a socket
// file with nothing behind it, and a proxy that refused to bind there would fail
// every second run — while one that removed it unconditionally would evict a live
// neighbour.
func TestStaleSocketIsRecoveredButLiveOneIsNot(t *testing.T) {
	sock := tempSocket(t)

	// Debris in both shapes: a leftover socket whose process is gone, and (some
	// crash paths) an ordinary file at the path.
	dead, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	dead.(*net.UnixListener).SetUnlinkOnClose(false)
	dead.Close() // socket file survives, nothing accepts on it
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("test setup left no stale socket: %v", err)
	}

	live, err := listenUnixSocket(sock)
	if err != nil {
		t.Fatalf("bind over a stale socket failed: %v", err)
	}
	// And now that something IS listening, a second bind must refuse rather than
	// unlink a working proxy out from under its run.
	serve(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), []net.Listener{live})
	if _, err := listenUnixSocket(sock); err == nil {
		t.Fatal("bound over a LIVE socket; a running proxy would have been evicted")
	} else if !strings.Contains(err.Error(), "already listening") {
		t.Fatalf("refusal does not name the cause: %v", err)
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("the refused bind removed the live socket anyway: %v", err)
	}
}

func TestUnixPathTooLongIsNamed(t *testing.T) {
	long := filepath.Join(os.TempDir(), strings.Repeat("x", unixPathMax), "e.sock")
	_, err := listenUnixSocket(long)
	if err == nil {
		t.Fatal("a path past the sun_path ceiling was accepted")
	}
	// bind() says "invalid argument", which sends the reader looking at the wrong
	// thing. The error has to say it is the length.
	if !strings.Contains(err.Error(), "caps a socket path") {
		t.Fatalf("error does not explain the ceiling: %v", err)
	}
}

// Both doors at once, one boundary behind them. The macOS host runners keep TCP
// (proven, and the MCP clients speak it), Linux needs the socket; a run that
// serves both must not have two different sets of rules.
func TestBothListenersServeTheSameHandler(t *testing.T) {
	sock, spawnDir := tempSocket(t), t.TempDir()
	dir := t.TempDir()
	addrFile := filepath.Join(dir, "addr")
	lns, err := openListeners("127.0.0.1:0", sock, addrFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(lns) != 2 {
		t.Fatalf("openListeners returned %d listeners, want 2", len(lns))
	}
	serve(t, buildHandler(t, "http://127.0.0.1:1", spawnDir), lns)

	tcpAddr := lns[0].Addr().String()
	// The announced address is the TCP one when TCP is served: that is the form
	// every existing client already reads.
	raw, err := os.ReadFile(addrFile)
	if err != nil || string(raw) != tcpAddr {
		t.Fatalf("addr file says %q, want the TCP address %q (%v)", raw, tcpAddr, err)
	}

	clients := map[string]*http.Client{"tcp": http.DefaultClient, "unix": unixClient(sock)}
	base := map[string]string{"tcp": "http://" + tcpAddr, "unix": "http://egress"}
	for door, cli := range clients {
		spawn := func(name, token string) int {
			body := `{"name":"` + name + `","body":{"cmd":"echo hi"}}`
			req, _ := http.NewRequest("POST", base[door]+"/control/spawn", strings.NewReader(body))
			req.Header.Set(egressTokenHeader, token)
			resp, err := cli.Do(req)
			if err != nil {
				t.Fatalf("%s door: %v", door, err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		if got := spawn("via-"+door, goodTok); got != http.StatusCreated {
			t.Fatalf("%s door: spawn got %d, want 201", door, got)
		}
		if got := spawn("sneak-"+door, "egr-wrong"); got != http.StatusUnauthorized {
			t.Fatalf("%s door: wrong token got %d, want 401", door, got)
		}
		if _, err := os.Stat(filepath.Join(spawnDir, "via-"+door+".json")); err != nil {
			t.Fatalf("%s door: no request file: %v", door, err)
		}
	}
}

// Unix-only, and the client has to be told so: `unix:<path>` rather than a
// host:port a client would try to dial as TCP and fail on with no idea why.
func TestAddrFileAnnouncesTheUnixForm(t *testing.T) {
	sock := tempSocket(t)
	dir := t.TempDir()
	addrFile := filepath.Join(dir, "addr")
	lns, err := openListeners("", sock, addrFile)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll(lns)

	raw, err := os.ReadFile(addrFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "unix:"+sock {
		t.Fatalf("addr file says %q, want %q", raw, "unix:"+sock)
	}
	// And the announced path is the one that answers.
	conn, err := net.Dial("unix", strings.TrimPrefix(string(raw), "unix:"))
	if err != nil {
		t.Fatalf("nothing listening at the announced socket: %v", err)
	}
	conn.Close()

	// Closing unlinks: a run that ends tidily leaves no debris for the next one.
	closeAll(lns)
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Fatalf("socket file survived Close: %v", err)
	}
}

// A socket-only run must not also open a TCP port. On Linux that port is the door
// that provably does not work, so opening it is a listener nobody asked for and
// nobody can use — and it would happen silently, since --listen has a default.
func TestSocketOnlyRunOpensNoPort(t *testing.T) {
	const dflt = "127.0.0.1:8091"
	for _, c := range []struct {
		name        string
		listenFlag  string
		listenAsked bool
		unixPath    string
		want        string
	}{
		{"socket only", dflt, false, "/tmp/e.sock", ""},
		{"both, TCP asked for explicitly", "127.0.0.1:0", true, "/tmp/e.sock", "127.0.0.1:0"},
		{"TCP only, the long-standing default", dflt, false, "", dflt},
		{"none, and nothing else", "none", true, "", ""},
	} {
		if got := resolveTCPAddr(c.listenFlag, c.listenAsked, c.unixPath); got != c.want {
			t.Fatalf("%s: TCP address %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNoListenerAtAllIsRefused(t *testing.T) {
	// `--listen none` with no socket is a proxy nothing can reach, which would come
	// up, log happily and serve no one — the same failure shape as the empty
	// config the constructor already refuses.
	if _, err := openListeners("", "", ""); err == nil {
		t.Fatal("openListeners accepted zero listeners")
	}
}

// The parent needs the port before it can put it in the kernel's environment,
// and a per-run proxy binds port 0 to avoid colliding with a concurrent run.
func TestListenAndAnnounceWritesResolvedPort(t *testing.T) {
	dir := t.TempDir()
	addrFile := filepath.Join(dir, "addr")
	lns, err := openListeners("127.0.0.1:0", "", addrFile)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll(lns)
	ln := lns[0]

	raw, err := os.ReadFile(addrFile)
	if err != nil {
		t.Fatalf("addr file not written: %v", err)
	}
	if string(raw) != ln.Addr().String() {
		t.Fatalf("addr file says %q, listener is on %q", raw, ln.Addr())
	}
	// The announced address must be the one that actually answers — a resolved
	// port that nothing is listening on is worse than no file at all.
	if _, _, err := net.SplitHostPort(string(raw)); err != nil {
		t.Fatalf("announced address is not host:port: %q", raw)
	}
	conn, err := net.Dial("tcp", string(raw))
	if err != nil {
		t.Fatalf("nothing listening at the announced address %q: %v", raw, err)
	}
	conn.Close()

	// No leftover temp file for a parent's directory scan to trip over.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("addr-file write left %d entries, want 1", len(entries))
	}
}

func TestNoProviderRoute(t *testing.T) {
	// The principle, not the string: intelligence enters the sandbox as
	// spawn() — started by the harness, recorded as a job, counted against the
	// run's budget and collected into its trace. A route to a model provider
	// would put a second, unbudgeted and untraced path to the same capability
	// inside the sandbox, reachable from any cell with the egress token.
	//
	// It must fail at CONFIG time. A proxy that comes up and 403s later has
	// already accepted a route table that says it exposes a provider.
	t.Setenv("TEST_ROUTE_CRED", realKey)
	aud := &auditor{out: io.Discard}
	for _, upstream := range []string{
		"https://api.anthropic.com",
		"https://API.Anthropic.com/v1",
		"https://api.openai.com/v1",
		"https://generativelanguage.googleapis.com",
	} {
		rt, err := buildRoute(routeConfig{Name: "brain", Upstream: upstream,
			CredHeader: "x-api-key", CredEnv: "TEST_ROUTE_CRED"}, aud)
		if err == nil {
			t.Fatalf("upstream %s was accepted as a route; intelligence must arrive via spawn()", upstream)
		}
		if rt != nil {
			t.Fatalf("upstream %s: refused but still returned a route", upstream)
		}
		if !strings.Contains(err.Error(), "spawn()") {
			t.Fatalf("upstream %s: refusal does not name the principle: %v", upstream, err)
		}
	}

	// And the refusal is targeted: an ordinary upstream still builds, including
	// one whose name merely contains a provider's (openai.com.evil.test would
	// be a suffix match; notopenai.com must not be).
	for _, ok := range []string{"https://api.weather.example", "https://notopenai.com"} {
		if _, err := buildRoute(routeConfig{Name: "svc", Upstream: ok,
			CredHeader: "x-api-key", CredEnv: "TEST_ROUTE_CRED"}, aud); err != nil {
			t.Fatalf("upstream %s was refused: %v", ok, err)
		}
	}
}
