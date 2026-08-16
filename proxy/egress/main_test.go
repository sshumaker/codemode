package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const (
	realKey = "sk-ant-REAL"
	goodTok = "cpx-deadbeef"
)

// buildHandler wires the same constructors main() uses, against a fake
// upstream, so the tests exercise the shipped pipeline rather than a copy.
func buildHandler(t *testing.T, upstreamURL string) http.Handler {
	t.Helper()
	up, err := url.Parse(upstreamURL)
	if err != nil {
		t.Fatal(err)
	}
	sess := &sessions{byTok: map[string]string{goodTok: "task-42"}, spends: map[string]int64{}}
	aud := &auditor{out: io.Discard}
	return newHandler(sess, aud, newReverseProxy(up, realKey, aud))
}

func TestSwapAndStrip(t *testing.T) {
	var got http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(200)
		io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	srv := httptest.NewServer(buildHandler(t, upstream.URL))
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("x-api-key", goodTok)
	req.Header.Set("Authorization", "Bearer "+goodTok) // belt and braces on the client side
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != `{"ok":true}` {
		t.Fatalf("proxying broke the response: %d %q", resp.StatusCode, body)
	}
	if got.Get("x-api-key") != realKey {
		t.Fatalf("upstream saw x-api-key=%q, want the real key", got.Get("x-api-key"))
	}
	if got.Get("Authorization") != "" {
		t.Fatalf("client Authorization header leaked upstream: %q", got.Get("Authorization"))
	}
	if got.Get(sessionHeader) != "" {
		t.Fatalf("internal session header leaked upstream: %q", got.Get(sessionHeader))
	}
	// The session token itself must not appear in ANY header upstream received.
	for k, vs := range got {
		for _, v := range vs {
			if strings.Contains(v, goodTok) {
				t.Fatalf("session token leaked upstream in header %s=%q", k, v)
			}
		}
	}
}

func TestBadTokenNeverReachesUpstream(t *testing.T) {
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	defer upstream.Close()

	srv := httptest.NewServer(buildHandler(t, upstream.URL))
	defer srv.Close()

	for _, tok := range []string{"", "cpx-wrong", realKey} { // the real key is NOT a valid client token
		req, _ := http.NewRequest("POST", srv.URL+"/v1/messages", strings.NewReader(`{}`))
		if tok != "" {
			req.Header.Set("x-api-key", tok)
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
		t.Fatalf("upstream was reached %d time(s) by unauthenticated requests", hits)
	}
}

func TestBearerFormWorks(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	srv := httptest.NewServer(buildHandler(t, upstream.URL))
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+goodTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("bearer-form token rejected: %d", resp.StatusCode)
	}
}
