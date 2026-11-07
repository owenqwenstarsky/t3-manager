package t3ext

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestParseClaudeUsage(t *testing.T) {
	body := []byte(`{
	  "five_hour":{"utilization":42.5,"resets_at":"2026-11-07T15:00:00.123+00:00"},
	  "seven_day":{"utilization":71,"resets_at":"2026-11-10T03:00:00Z"},
	  "seven_day_opus":{"utilization":12,"resets_at":null},
	  "seven_day_oauth_apps":null,
	  "codename_feature":{"utilization":3},
	  "extra_usage":{"is_enabled":true,"monthly_limit":5000,"used_credits":120,"utilization":2.4}
	}`)
	l, err := parseClaudeUsage(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Windows) != 3 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	w := l.Windows[0]
	if w.ID != "5h" || w.Label != "5-hour" || w.UsedPercent != 42.5 || w.ResetsAt == nil || w.ResetsAt.Hour() != 15 {
		t.Fatalf("5h window = %+v", w)
	}
	if l.Windows[1].ID != "7d" || l.Windows[1].UsedPercent != 71 || l.Windows[2].ID != "7d_opus" || l.Windows[2].ResetsAt != nil {
		t.Fatalf("weekly windows = %+v", l.Windows[1:])
	}
	if l.Extra == nil || !l.Extra.Enabled || *l.Extra.UsedPercent != 2.4 {
		t.Fatalf("extra = %+v", l.Extra)
	}
	if l.LimitReached {
		t.Fatal("limit should not be reached")
	}
}

func TestParseCodexUsage(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	body := []byte(`{
	  "plan_type":"plus",
	  "rate_limit":{"allowed":true,"limit_reached":false,
	    "primary_window":{"used_percent":8,"limit_window_seconds":18000,"reset_after_seconds":600,"reset_at":0},
	    "secondary_window":{"used_percent":55,"limit_window_seconds":604800,"reset_at":1794830400}},
	  "credits":{"has_credits":false,"unlimited":false,"balance":"0"},
	  "additional_rate_limits":[{"limit_name":"GPT-5.3-Codex-Spark","rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":18000,"reset_after_seconds":60}}}]
	}`)
	l, err := parseCodexUsage(body, now)
	if err != nil {
		t.Fatal(err)
	}
	if l.Plan != "plus" || len(l.Windows) != 3 {
		t.Fatalf("limits = %+v", l)
	}
	if l.Windows[0].ID != "5h" || !l.Windows[0].ResetsAt.Equal(now.Add(10*time.Minute)) {
		t.Fatalf("primary = %+v", l.Windows[0])
	}
	if l.Windows[1].ID != "gpt_5_3_codex_spark_5h" || l.Windows[1].UsedPercent != 100 {
		t.Fatalf("additional = %+v", l.Windows[1])
	}
	if l.Windows[2].ID != "7d" || l.Windows[2].Label != "Weekly" || l.Windows[2].ResetsAt.Unix() != 1794830400 {
		t.Fatalf("secondary = %+v", l.Windows[2])
	}
	if l.Credits == nil || l.Credits.Balance != "0" {
		t.Fatalf("credits = %+v", l.Credits)
	}
}

func TestLimitsFromSignals(t *testing.T) {
	at := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	claude := limitsFromSignals("claude", map[string]string{
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.25",
		"Anthropic-Ratelimit-Unified-5h-Reset":       "1794070800",
		"Anthropic-Ratelimit-Unified-7d-Utilization": "0.9",
		"Anthropic-Ratelimit-Unified-Status":         "allowed",
	}, at)
	if claude == nil || len(claude.Windows) != 2 || claude.Windows[0].UsedPercent != 25 || claude.Windows[1].UsedPercent != 90 {
		t.Fatalf("claude = %+v", claude)
	}
	if claude.Windows[0].ResetsAt == nil || claude.Windows[0].ResetsAt.Unix() != 1794070800 || claude.Source != "headers" {
		t.Fatalf("claude reset/source = %+v", claude)
	}
	codex := limitsFromSignals("codex", map[string]string{
		"X-Codex-Plan-Type":                   "pro",
		"X-Codex-Primary-Used-Percent":        "12.5",
		"X-Codex-Primary-Window-Minutes":      "300",
		"X-Codex-Primary-Reset-After-Seconds": "120",
		"X-Codex-Secondary-Used-Percent":      "40",
		"X-Codex-Secondary-Window-Minutes":    "10080",
		"X-Codex-Limit-Reached":               "false",
	}, at)
	if codex == nil || codex.Plan != "pro" || len(codex.Windows) != 2 || codex.Windows[0].ID != "5h" || codex.Windows[1].ID != "7d" {
		t.Fatalf("codex = %+v", codex)
	}
	if !codex.Windows[0].ResetsAt.Equal(at.Add(2 * time.Minute)) {
		t.Fatalf("codex reset = %v", codex.Windows[0].ResetsAt)
	}
	if limitsFromSignals("claude", nil, at) != nil || limitsFromSignals("gemini", map[string]string{"x": "y"}, at) != nil {
		t.Fatal("expected nil for empty or unsupported")
	}
}

func TestOverlaySignals(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	t1 := t0.Add(2 * time.Minute)
	live := &AccountLimits{Source: "live", ObservedAt: &t0, Windows: []LimitWindow{
		{ID: "5h", UsedPercent: 10, WindowSeconds: 18000},
		{ID: "7d", UsedPercent: 50, WindowSeconds: 604800},
		{ID: "7d_opus", UsedPercent: 5, WindowSeconds: 604800},
	}}
	newer := &AccountLimits{Source: "headers", ObservedAt: &t1, Windows: []LimitWindow{
		{ID: "5h", UsedPercent: 30, WindowSeconds: 18000},
		{ID: "7d", UsedPercent: 52, WindowSeconds: 604800},
	}}
	m := overlaySignals(live, newer)
	if m.Windows[0].UsedPercent != 30 || m.Windows[1].UsedPercent != 52 || m.Windows[2].ID != "7d_opus" || m.Windows[2].UsedPercent != 5 {
		t.Fatalf("merged = %+v", m.Windows)
	}
	if live.Windows[0].UsedPercent != 10 {
		t.Fatal("overlay mutated the cached snapshot")
	}
	older := &AccountLimits{Source: "headers", ObservedAt: &t0, Windows: []LimitWindow{{ID: "5h", UsedPercent: 99}}}
	if overlaySignals(live, older) != live {
		t.Fatal("older headers should not win")
	}
	if overlaySignals(nil, newer) != newer {
		t.Fatal("headers should stand in for a missing live snapshot")
	}
}

func TestLimitsCacheTTL(t *testing.T) {
	var calls atomic.Int32
	fail := false
	c := NewLimitsCache(func(context.Context, *config.Config, *coreauth.Auth) (*AccountLimits, error) {
		calls.Add(1)
		if fail {
			return nil, errors.New("boom")
		}
		return &AccountLimits{Windows: []LimitWindow{{ID: "5h", UsedPercent: float64(calls.Load())}}}, nil
	})
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	a := &coreauth.Auth{ID: "a1", Provider: "claude"}
	ctx := context.Background()

	l, _, _ := c.Get(ctx, nil, a, false)
	if calls.Load() != 1 || l.Source != "live" {
		t.Fatalf("first get: calls=%d l=%+v", calls.Load(), l)
	}
	now = now.Add(4*time.Minute + 59*time.Second)
	c.Get(ctx, nil, a, false)
	if calls.Load() != 1 {
		t.Fatal("refetched inside the 5 minute TTL")
	}
	c.Get(ctx, nil, a, true)
	if calls.Load() != 2 {
		t.Fatal("forced refresh should refetch once older than 30s")
	}
	now = now.Add(10 * time.Second)
	c.Get(ctx, nil, a, true)
	if calls.Load() != 2 {
		t.Fatal("forced refresh within 30s should use the cache")
	}
	now = now.Add(5 * time.Minute)
	fail = true
	l, errMsg, _ := c.Get(ctx, nil, a, false)
	if calls.Load() != 3 || errMsg != "boom" || l == nil || l.Windows[0].UsedPercent != 2 {
		t.Fatalf("failure should keep the last good snapshot: calls=%d err=%q l=%+v", calls.Load(), errMsg, l)
	}
	now = now.Add(30 * time.Second)
	c.Get(ctx, nil, a, false)
	if calls.Load() != 3 {
		t.Fatal("errors should be cached for a minute")
	}
	now = now.Add(31 * time.Second)
	fail = false
	_, errMsg, _ = c.Get(ctx, nil, a, false)
	if calls.Load() != 4 || errMsg != "" {
		t.Fatalf("retry after error TTL: calls=%d err=%q", calls.Load(), errMsg)
	}
}

func TestLimitsCacheSingleFlight(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	c := NewLimitsCache(func(context.Context, *config.Config, *coreauth.Auth) (*AccountLimits, error) {
		calls.Add(1)
		<-release
		return &AccountLimits{}, nil
	})
	a := &coreauth.Auth{ID: "a1", Provider: "codex"}
	done := make(chan struct{})
	for i := 0; i < 5; i++ {
		go func() { c.Get(context.Background(), nil, a, false); done <- struct{}{} }()
	}
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(release)
	for i := 0; i < 5; i++ {
		<-done
	}
	if calls.Load() != 1 {
		t.Fatalf("concurrent gets fetched %d times", calls.Load())
	}
}

func TestSnapshotHeadersOnly(t *testing.T) {
	c := NewLimitsCache(func(context.Context, *config.Config, *coreauth.Auth) (*AccountLimits, error) {
		return nil, errors.New("no OAuth access token")
	})
	at := time.Now()
	a := &coreauth.Auth{ID: "a1", Index: "idx", Provider: "claude", Quota: coreauth.QuotaState{ObservedAt: at, Signals: map[string]string{
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.5",
	}}}
	s := c.Snapshot(context.Background(), nil, a, false)
	if s.Source != "headers" || s.AuthID != "a1" || s.AuthIndex != "idx" || s.Error == "" || len(s.Windows) != 1 || s.Windows[0].UsedPercent != 50 {
		t.Fatalf("snapshot = %+v", s)
	}
	b := &coreauth.Auth{ID: "b1", Provider: "codex"}
	s = c.Snapshot(context.Background(), nil, b, false)
	if s.Source != "none" || s.Windows == nil {
		t.Fatalf("empty snapshot = %+v", s)
	}
}
