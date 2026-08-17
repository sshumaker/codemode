package main

import (
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

// buildServer wires the same constructors main() uses, against a fake upstream.
func buildServer(t *testing.T, upstreamURL, spawnDir string) *httptest.Server {
	t.Helper()
	t.Setenv("TEST_ROUTE_CRED", realKey)
	rc := routeConfig{Name: "svc", Upstream: upstreamURL, CredHeader: "x-api-key", CredEnv: "TEST_ROUTE_CRED"}
	aud := &auditor{out: io.Discard}
	rt, err := buildRoute(rc, aud)
	if err != nil {
		t.Fatal(err)
	}
	sess := &sessions{byTok: map[string]string{goodTok: "task-42"}, spends: map[string]int64{}}
	return httptest.NewServer(newHandler(sess, aud, map[string]*route{"svc": rt}, spawnDir))
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

// The parent needs the port before it can put it in the kernel's environment,
// and a per-run proxy binds port 0 to avoid colliding with a concurrent run.
func TestListenAndAnnounceWritesResolvedPort(t *testing.T) {
	dir := t.TempDir()
	addrFile := filepath.Join(dir, "addr")
	ln, err := listenAndAnnounce("127.0.0.1:0", addrFile)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

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
