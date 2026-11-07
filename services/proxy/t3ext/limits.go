package t3ext

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	claudeauth "github.com/router-for-me/CLIProxyAPI/v8/internal/auth/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Subscription limits: how much of each account's rolling windows (Claude's
// 5-hour and weekly limits, ChatGPT's primary and secondary Codex windows) is
// used. Two sources feed it:
//
//   - live: the provider's own usage endpoint, the one its CLI calls for
//     /usage. It is cached per account for limitsTTL so viewing the dashboard
//     never hammers the provider.
//   - headers: the rate-limit headers upstream captures passively on every
//     proxied response (coreauth.QuotaState.Signals). They cost nothing and are
//     applied on top of a cached live result when they are newer.

const (
	claudeUsageURL = "https://api.anthropic.com/api/oauth/usage"
	codexUsageURL  = "https://chatgpt.com/backend-api/wham/usage"
	codexProbeUA   = "codex_cli_rs/0.154.0"

	limitsTTL          = 5 * time.Minute
	limitsErrorTTL     = time.Minute
	limitsMinRefresh   = 30 * time.Second
	limitsProbeTimeout = 15 * time.Second
	limitsConcurrency  = 4
)

// LimitWindow is one rolling limit.
type LimitWindow struct {
	ID            string     `json:"id"`
	Label         string     `json:"label"`
	UsedPercent   float64    `json:"used_percent"`
	ResetsAt      *time.Time `json:"resets_at,omitempty"`
	WindowSeconds int64      `json:"window_seconds,omitempty"`
}

// ExtraUsage describes Claude's pay-as-you-go overage, when the account has it.
type ExtraUsage struct {
	Enabled      bool     `json:"enabled"`
	UsedPercent  *float64 `json:"used_percent,omitempty"`
	UsedCredits  *float64 `json:"used_credits,omitempty"`
	MonthlyLimit *float64 `json:"monthly_limit,omitempty"`
}

// Credits describes a ChatGPT account's Codex credit balance.
type Credits struct {
	HasCredits bool   `json:"has_credits"`
	Unlimited  bool   `json:"unlimited"`
	Balance    string `json:"balance,omitempty"`
}

// AccountLimits is the limit snapshot for one credential.
type AccountLimits struct {
	AuthID       string        `json:"auth_id"`
	AuthIndex    string        `json:"auth_index,omitempty"`
	Provider     string        `json:"provider"`
	Plan         string        `json:"plan,omitempty"`
	Source       string        `json:"source"` // live | headers | none
	ObservedAt   *time.Time    `json:"observed_at,omitempty"`
	FetchedAt    *time.Time    `json:"fetched_at,omitempty"`
	LimitReached bool          `json:"limit_reached"`
	Windows      []LimitWindow `json:"windows"`
	Extra        *ExtraUsage   `json:"extra_usage,omitempty"`
	Credits      *Credits      `json:"credits,omitempty"`
	Error        string        `json:"error,omitempty"`
}

// limitsProvider reports whether limits can be read for a provider.
func limitsProvider(provider string) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "claude", "codex":
		return true
	}
	return false
}

// --- parsing -----------------------------------------------------------------

var claudeWindowLabels = map[string]string{
	"five_hour":            "5-hour",
	"seven_day":            "Weekly",
	"seven_day_opus":       "Weekly · Opus",
	"seven_day_sonnet":     "Weekly · Sonnet",
	"seven_day_oauth_apps": "Weekly · apps",
}

var claudeWindowIDs = map[string]string{
	"five_hour":            "5h",
	"seven_day":            "7d",
	"seven_day_opus":       "7d_opus",
	"seven_day_sonnet":     "7d_sonnet",
	"seven_day_oauth_apps": "7d_apps",
}

// parseClaudeUsage reads the body of Anthropic's /api/oauth/usage. Each window
// is an object {utilization: percent 0-100, resets_at: RFC 3339 | null}; a null
// window does not apply to the account.
func parseClaudeUsage(body []byte) (*AccountLimits, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, fmt.Errorf("parse Claude usage: %w", err)
	}
	out := &AccountLimits{Provider: "claude", Windows: []LimitWindow{}}
	for key, raw := range root {
		if key == "extra_usage" {
			var extra struct {
				IsEnabled    bool     `json:"is_enabled"`
				MonthlyLimit *float64 `json:"monthly_limit"`
				UsedCredits  *float64 `json:"used_credits"`
				Utilization  *float64 `json:"utilization"`
			}
			if json.Unmarshal(raw, &extra) == nil {
				out.Extra = &ExtraUsage{Enabled: extra.IsEnabled, UsedPercent: extra.Utilization,
					UsedCredits: extra.UsedCredits, MonthlyLimit: extra.MonthlyLimit}
			}
			continue
		}
		if !strings.HasPrefix(key, "five_hour") && !strings.HasPrefix(key, "seven_day") {
			continue
		}
		var w struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    *string  `json:"resets_at"`
		}
		if json.Unmarshal(raw, &w) != nil || w.Utilization == nil {
			continue
		}
		win := LimitWindow{ID: claudeWindowIDs[key], Label: claudeWindowLabels[key], UsedPercent: clampPercent(*w.Utilization)}
		if win.ID == "" {
			win.ID = key
			win.Label = humanizeKey(key)
		}
		if strings.HasPrefix(key, "five_hour") {
			win.WindowSeconds = 5 * 3600
		} else {
			win.WindowSeconds = 7 * 86400
		}
		if w.ResetsAt != nil {
			if t, err := time.Parse(time.RFC3339Nano, *w.ResetsAt); err == nil {
				t = t.UTC()
				win.ResetsAt = &t
			}
		}
		if win.UsedPercent >= 100 {
			out.LimitReached = true
		}
		out.Windows = append(out.Windows, win)
	}
	sortWindows(out.Windows)
	return out, nil
}

type codexWindowJSON struct {
	UsedPercent        *float64 `json:"used_percent"`
	LimitWindowSeconds int64    `json:"limit_window_seconds"`
	ResetAfterSeconds  *int64   `json:"reset_after_seconds"`
	ResetAt            *int64   `json:"reset_at"`
}

type codexRateLimitJSON struct {
	Allowed         *bool            `json:"allowed"`
	LimitReached    bool             `json:"limit_reached"`
	PrimaryWindow   *codexWindowJSON `json:"primary_window"`
	SecondaryWindow *codexWindowJSON `json:"secondary_window"`
}

// parseCodexUsage reads the body of ChatGPT's /backend-api/wham/usage.
func parseCodexUsage(body []byte, now time.Time) (*AccountLimits, error) {
	var root struct {
		PlanType  string              `json:"plan_type"`
		RateLimit *codexRateLimitJSON `json:"rate_limit"`
		Credits   *struct {
			HasCredits bool            `json:"has_credits"`
			Unlimited  bool            `json:"unlimited"`
			Balance    json.RawMessage `json:"balance"`
		} `json:"credits"`
		Additional []struct {
			LimitName string              `json:"limit_name"`
			RateLimit *codexRateLimitJSON `json:"rate_limit"`
		} `json:"additional_rate_limits"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, fmt.Errorf("parse Codex usage: %w", err)
	}
	out := &AccountLimits{Provider: "codex", Plan: root.PlanType, Windows: []LimitWindow{}}
	if rl := root.RateLimit; rl != nil {
		out.LimitReached = rl.LimitReached || (rl.Allowed != nil && !*rl.Allowed)
		for _, w := range []*codexWindowJSON{rl.PrimaryWindow, rl.SecondaryWindow} {
			if win, ok := codexWindow(w, "", now); ok {
				out.Windows = append(out.Windows, win)
			}
		}
	}
	for _, extra := range root.Additional {
		if extra.RateLimit == nil || strings.TrimSpace(extra.LimitName) == "" {
			continue
		}
		for _, w := range []*codexWindowJSON{extra.RateLimit.PrimaryWindow, extra.RateLimit.SecondaryWindow} {
			if win, ok := codexWindow(w, extra.LimitName, now); ok {
				out.Windows = append(out.Windows, win)
			}
		}
	}
	if c := root.Credits; c != nil {
		balance := strings.Trim(strings.TrimSpace(string(c.Balance)), `"`)
		if balance == "null" {
			balance = ""
		}
		out.Credits = &Credits{HasCredits: c.HasCredits, Unlimited: c.Unlimited, Balance: balance}
	}
	sortWindows(out.Windows)
	return out, nil
}

func codexWindow(w *codexWindowJSON, scope string, now time.Time) (LimitWindow, bool) {
	if w == nil || w.UsedPercent == nil {
		return LimitWindow{}, false
	}
	win := LimitWindow{UsedPercent: clampPercent(*w.UsedPercent), WindowSeconds: w.LimitWindowSeconds}
	switch {
	case w.ResetAt != nil && *w.ResetAt > 0:
		t := time.Unix(*w.ResetAt, 0).UTC()
		win.ResetsAt = &t
	case w.ResetAfterSeconds != nil && *w.ResetAfterSeconds >= 0:
		t := now.Add(time.Duration(*w.ResetAfterSeconds) * time.Second).UTC()
		win.ResetsAt = &t
	}
	win.ID, win.Label = windowName(w.LimitWindowSeconds)
	if scope != "" {
		win.ID = normalizeID(scope) + "_" + win.ID
		win.Label = win.Label + " · " + scope
	}
	return win, true
}

// windowName names a window by its length: 5h and 7d are the familiar ones.
func windowName(seconds int64) (id, label string) {
	switch {
	case seconds == 5*3600:
		return "5h", "5-hour"
	case seconds == 7*86400:
		return "7d", "Weekly"
	case seconds <= 0:
		return "window", "Limit"
	case seconds%86400 == 0:
		d := seconds / 86400
		return fmt.Sprintf("%dd", d), fmt.Sprintf("%d-day", d)
	case seconds%3600 == 0:
		h := seconds / 3600
		return fmt.Sprintf("%dh", h), fmt.Sprintf("%d-hour", h)
	default:
		m := seconds / 60
		return fmt.Sprintf("%dm", m), fmt.Sprintf("%d-minute", m)
	}
}

// limitsFromSignals turns the passively captured response headers into
// windows. Claude headers carry utilization as a 0-1 fraction and resets as
// unix seconds; Codex headers carry percent, window minutes and reset times.
func limitsFromSignals(provider string, signals map[string]string, observedAt time.Time) *AccountLimits {
	if len(signals) == 0 {
		return nil
	}
	get := func(name string) string {
		for k, v := range signals {
			if strings.EqualFold(k, name) {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	out := &AccountLimits{Provider: provider, Windows: []LimitWindow{}}
	switch strings.ToLower(provider) {
	case "claude":
		for _, spec := range []struct {
			key, id, label string
			secs           int64
		}{
			{"5h", "5h", "5-hour", 5 * 3600},
			{"7d", "7d", "Weekly", 7 * 86400},
		} {
			raw := get("Anthropic-Ratelimit-Unified-" + spec.key + "-Utilization")
			u, err := strconv.ParseFloat(raw, 64)
			if raw == "" || err != nil || math.IsNaN(u) {
				continue
			}
			win := LimitWindow{ID: spec.id, Label: spec.label, UsedPercent: clampPercent(u * 100), WindowSeconds: spec.secs}
			if t, ok := unixTime(get("Anthropic-Ratelimit-Unified-" + spec.key + "-Reset")); ok {
				win.ResetsAt = &t
			}
			out.Windows = append(out.Windows, win)
		}
		status := strings.ToLower(get("Anthropic-Ratelimit-Unified-Status"))
		out.LimitReached = status == "rejected"
	case "codex":
		out.Plan = get("X-Codex-Plan-Type")
		for _, name := range []string{"Primary", "Secondary"} {
			raw := get("X-Codex-" + name + "-Used-Percent")
			u, err := strconv.ParseFloat(raw, 64)
			if raw == "" || err != nil || math.IsNaN(u) {
				continue
			}
			mins, _ := strconv.ParseInt(get("X-Codex-"+name+"-Window-Minutes"), 10, 64)
			win := LimitWindow{UsedPercent: clampPercent(u), WindowSeconds: mins * 60}
			win.ID, win.Label = windowName(win.WindowSeconds)
			if t, ok := unixTime(get("X-Codex-" + name + "-Reset-At")); ok {
				win.ResetsAt = &t
			} else if secs, errSecs := strconv.ParseInt(get("X-Codex-"+name+"-Reset-After-Seconds"), 10, 64); errSecs == nil && secs >= 0 {
				t := observedAt.Add(time.Duration(secs) * time.Second).UTC()
				win.ResetsAt = &t
			}
			out.Windows = append(out.Windows, win)
		}
		reached := strings.ToLower(get("X-Codex-Limit-Reached"))
		out.LimitReached = reached == "true" || reached == "1"
	default:
		return nil
	}
	if len(out.Windows) == 0 {
		return nil
	}
	sortWindows(out.Windows)
	out.Source = "headers"
	if !observedAt.IsZero() {
		t := observedAt.UTC()
		out.ObservedAt = &t
	}
	return out
}

// overlaySignals applies newer header windows onto a live snapshot, keeping
// windows the headers don't carry (Opus/Sonnet weekly, additional limits).
func overlaySignals(live, headers *AccountLimits) *AccountLimits {
	if headers == nil {
		return live
	}
	if live == nil || live.Source != "live" {
		return headers
	}
	if headers.ObservedAt == nil || live.ObservedAt == nil || !headers.ObservedAt.After(*live.ObservedAt) {
		return live
	}
	merged := *live
	merged.Windows = append([]LimitWindow(nil), live.Windows...)
	for _, hw := range headers.Windows {
		replaced := false
		for i := range merged.Windows {
			if merged.Windows[i].ID == hw.ID {
				merged.Windows[i].UsedPercent = hw.UsedPercent
				if hw.ResetsAt != nil {
					merged.Windows[i].ResetsAt = hw.ResetsAt
				}
				replaced = true
				break
			}
		}
		if !replaced {
			merged.Windows = append(merged.Windows, hw)
		}
	}
	sortWindows(merged.Windows)
	merged.LimitReached = headers.LimitReached
	for _, w := range merged.Windows {
		if w.UsedPercent >= 100 {
			merged.LimitReached = true
		}
	}
	merged.ObservedAt = headers.ObservedAt
	if merged.Plan == "" {
		merged.Plan = headers.Plan
	}
	return &merged
}

func unixTime(raw string) (time.Time, bool) {
	if raw == "" {
		return time.Time{}, false
	}
	if n, err := strconv.ParseFloat(raw, 64); err == nil && n > 0 {
		return time.Unix(int64(n), 0).UTC(), true
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func clampPercent(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return math.Round(v*10) / 10
}

// sortWindows orders windows shortest first, then by id, so 5-hour leads.
func sortWindows(ws []LimitWindow) {
	sort.SliceStable(ws, func(i, j int) bool {
		if ws[i].WindowSeconds != ws[j].WindowSeconds {
			return ws[i].WindowSeconds < ws[j].WindowSeconds
		}
		return ws[i].ID < ws[j].ID
	})
}

func humanizeKey(key string) string {
	s := strings.ReplaceAll(key, "_", " ")
	if s == "" {
		return key
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func normalizeID(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return strings.Trim(b.String(), "_")
}

// --- fetching ----------------------------------------------------------------

func metaString(a *coreauth.Auth, key string) string {
	if a == nil || a.Metadata == nil {
		return ""
	}
	if v, ok := a.Metadata[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

type limitsFetcher func(ctx context.Context, cfg *config.Config, a *coreauth.Auth) (*AccountLimits, error)

func fetchLiveLimits(ctx context.Context, cfg *config.Config, a *coreauth.Auth) (*AccountLimits, error) {
	token := metaString(a, "access_token")
	if token == "" {
		return nil, fmt.Errorf("no OAuth access token (API-key credentials have no subscription limits)")
	}
	ctx, cancel := context.WithTimeout(ctx, limitsProbeTimeout)
	defer cancel()
	now := time.Now()
	switch strings.ToLower(a.Provider) {
	case "claude":
		proxyURL := strings.TrimSpace(a.ProxyURL)
		sdkCfg := config.SDKConfig{}
		if cfg != nil {
			sdkCfg = cfg.SDKConfig
			if proxyURL == "" {
				proxyURL = strings.TrimSpace(cfg.ProxyURL)
			}
		}
		sdkCfg.ProxyURL = proxyURL
		// Same Cloudflare-friendly client upstream uses for the OAuth control plane.
		client := claudeauth.NewAnthropicHttpClient(&sdkCfg)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, claudeUsageURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json, text/plain, */*")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "axios/1.15.2")
		req.Header.Set("Accept-Encoding", "gzip, deflate, br")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("anthropic-beta", "oauth-2025-04-20")
		body, err := doLimitsRequest(client, req)
		if err != nil {
			return nil, err
		}
		return parseClaudeUsage(body)
	case "codex":
		client := helps.NewProxyAwareHTTPClient(ctx, cfg, a, limitsProbeTimeout)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, codexUsageURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", codexProbeUA)
		req.Header.Set("Authorization", "Bearer "+token)
		if id := metaString(a, "account_id"); id != "" {
			req.Header.Set("ChatGPT-Account-Id", id)
		}
		body, err := doLimitsRequest(client, req)
		if err != nil {
			return nil, err
		}
		return parseCodexUsage(body, now)
	}
	return nil, fmt.Errorf("provider %q has no subscription limits", a.Provider)
}

func doLimitsRequest(client *http.Client, req *http.Request) ([]byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s: %w", req.URL.Host, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", req.URL.Host, err)
	}
	body, err := decodeBody(raw, resp.Header.Values("Content-Encoding"))
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, fmt.Errorf("%s rejected the access token (401); refresh the account", req.URL.Host)
	case resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%s refused the usage lookup (403)", req.URL.Host)
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, fmt.Errorf("%s rate-limited the usage lookup (429)", req.URL.Host)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, fmt.Errorf("%s answered %d", req.URL.Host, resp.StatusCode)
	}
	return body, nil
}

func decodeBody(body []byte, encodings []string) ([]byte, error) {
	list := strings.Split(strings.Join(encodings, ","), ",")
	for i := len(list) - 1; i >= 0; i-- {
		var r io.Reader
		switch strings.ToLower(strings.TrimSpace(list[i])) {
		case "", "identity":
			continue
		case "gzip":
			gz, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				return nil, fmt.Errorf("decode gzip: %w", err)
			}
			r = gz
		case "deflate":
			r = flate.NewReader(bytes.NewReader(body))
		case "br":
			r = brotli.NewReader(bytes.NewReader(body))
		default:
			return nil, fmt.Errorf("unsupported content encoding %q", list[i])
		}
		decoded, err := io.ReadAll(io.LimitReader(r, 4<<20))
		if err != nil {
			return nil, fmt.Errorf("decode body: %w", err)
		}
		body = decoded
	}
	return body, nil
}

// --- cache -------------------------------------------------------------------

type limitsEntry struct {
	at       time.Time
	limits   *AccountLimits
	err      string
	inflight chan struct{}
}

// LimitsCache holds live snapshots per credential for limitsTTL.
type LimitsCache struct {
	mu      sync.Mutex
	entries map[string]*limitsEntry
	fetch   limitsFetcher
	now     func() time.Time
	sem     chan struct{}
}

// NewLimitsCache returns a cache that reads limits with fetch.
func NewLimitsCache(fetch limitsFetcher) *LimitsCache {
	if fetch == nil {
		fetch = fetchLiveLimits
	}
	return &LimitsCache{entries: map[string]*limitsEntry{}, fetch: fetch, now: time.Now, sem: make(chan struct{}, limitsConcurrency)}
}

// Get returns the live snapshot for a credential, fetching it when the cached
// one is older than limitsTTL (limitsErrorTTL after a failure). force fetches
// again unless the cached snapshot is younger than limitsMinRefresh.
func (c *LimitsCache) Get(ctx context.Context, cfg *config.Config, a *coreauth.Auth, force bool) (*AccountLimits, string, time.Time) {
	for {
		c.mu.Lock()
		e := c.entries[a.ID]
		now := c.now()
		if e != nil && e.inflight != nil {
			ch := e.inflight
			c.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err().Error(), time.Time{}
			}
		}
		if e != nil {
			age := now.Sub(e.at)
			ttl := limitsTTL
			if e.err != "" {
				ttl = limitsErrorTTL
			}
			if age < limitsMinRefresh || (!force && age < ttl) {
				l, errMsg, at := e.limits, e.err, e.at
				c.mu.Unlock()
				return l, errMsg, at
			}
		}
		ch := make(chan struct{})
		if e == nil {
			e = &limitsEntry{}
			c.entries[a.ID] = e
		}
		e.inflight = ch
		c.mu.Unlock()

		c.sem <- struct{}{}
		limits, err := c.fetch(context.WithoutCancel(ctx), cfg, a)
		<-c.sem

		c.mu.Lock()
		e.at = c.now()
		e.inflight = nil
		if err != nil {
			e.err = err.Error()
			// Keep the last good snapshot to show alongside the error.
		} else {
			e.err = ""
			at := e.at.UTC()
			limits.Source = "live"
			limits.ObservedAt = &at
			limits.FetchedAt = &at
			e.limits = limits
		}
		l, errMsg, at := e.limits, e.err, e.at
		c.mu.Unlock()
		close(ch)
		return l, errMsg, at
	}
}

// Forget drops credentials that no longer exist.
func (c *LimitsCache) Forget(keep map[string]bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, e := range c.entries {
		if !keep[id] && e.inflight == nil {
			delete(c.entries, id)
		}
	}
}

// Snapshot builds the response for one credential: the cached live result,
// overlaid with newer passive header signals.
func (c *LimitsCache) Snapshot(ctx context.Context, cfg *config.Config, a *coreauth.Auth, force bool) AccountLimits {
	live, errMsg, _ := c.Get(ctx, cfg, a, force)
	headers := limitsFromSignals(a.Provider, a.Quota.Signals, a.Quota.ObservedAt)
	var out AccountLimits
	if merged := overlaySignals(live, headers); merged != nil {
		out = *merged
	} else {
		out = AccountLimits{Provider: a.Provider, Source: "none", Windows: []LimitWindow{}}
	}
	out.AuthID = a.ID
	out.AuthIndex = a.Index
	out.Provider = strings.ToLower(a.Provider)
	out.Error = errMsg
	if out.Windows == nil {
		out.Windows = []LimitWindow{}
	}
	if out.Plan == "" {
		out.Plan = metaString(a, "plan_type")
	}
	return out
}
