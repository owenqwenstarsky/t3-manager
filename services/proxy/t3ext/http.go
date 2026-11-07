package t3ext

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/csv"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	sdkAuth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	log "github.com/sirupsen/logrus"
)

// Version identifies the t3ext API revision.
const Version = "1"

// ServerOptions returns the API server options that mount t3ext.
func ServerOptions() []api.ServerOption {
	if !Enabled() {
		return nil
	}
	if _, err := SharedStore(); err != nil {
		log.WithError(err).Error("t3ext: routes disabled because the usage store failed to open")
		return nil
	}
	return []api.ServerOption{api.WithRouterConfigurator(func(e *gin.Engine, _ *handlers.BaseAPIHandler, cfg *config.Config) {
		Mount(e, cfg)
	})}
}

// Mount registers t3ext routes on an engine.
func Mount(e *gin.Engine, cfg *config.Config) {
	h := &handler{cfg: cfg, devices: map[string]*deviceSession{}}
	e.GET("/t3/v1/health", h.health)
	g := e.Group("/t3/v1", requireManagementKey())
	g.GET("/usage/summary", h.summary)
	g.GET("/usage/timeseries", h.timeseries)
	g.GET("/usage/windows", h.windows)
	g.GET("/usage/events", h.events)
	g.GET("/usage/live", h.live)
	g.GET("/usage/export.csv", h.exportCSV)
	g.GET("/keys", h.listKeys)
	g.PUT("/keys/:key", h.putKey)
	g.DELETE("/keys/:key", h.deleteKey)
	g.POST("/oauth/codex-device", h.startDevice)
	g.GET("/oauth/codex-device/:id", h.deviceStatus)
	g.DELETE("/oauth/codex-device/:id", h.cancelDevice)
}

// requireManagementKey accepts the MANAGEMENT_PASSWORD as a bearer token or
// X-Management-Key header. Without it configured, the routes stay closed.
func requireManagementKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		secret := os.Getenv("MANAGEMENT_PASSWORD")
		if secret == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "MANAGEMENT_PASSWORD is not set"})
			return
		}
		got := strings.TrimSpace(c.GetHeader("X-Management-Key"))
		if got == "" {
			auth := c.GetHeader("Authorization")
			if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
				got = strings.TrimSpace(auth[7:])
			}
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid management key"})
			return
		}
		c.Next()
	}
}

type handler struct {
	cfg *config.Config

	mu      sync.Mutex
	devices map[string]*deviceSession
}

func (h *handler) store(c *gin.Context) *Store {
	s, err := SharedStore()
	if err != nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "usage store unavailable"})
		return nil
	}
	return s
}

func (h *handler) health(c *gin.Context) {
	_, err := SharedStore()
	c.JSON(http.StatusOK, gin.H{"ok": err == nil, "t3ext": Version})
}

// parseTime accepts unix milliseconds or RFC3339.
func parseTime(raw string, def int64) (int64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, true
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return n, true
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}

func parseQuery(c *gin.Context, defaultWindow time.Duration) (Query, bool) {
	now := time.Now().UnixMilli()
	to, okTo := parseTime(c.Query("to"), now+1)
	from, okFrom := parseTime(c.Query("from"), to-defaultWindow.Milliseconds())
	if !okTo || !okFrom {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "from/to must be unix milliseconds or RFC3339"})
		return Query{}, false
	}
	q := Query{From: from, To: to, Step: c.Query("step"), Filters: map[string]string{}}
	if tz := c.Query("tz"); tz != "" {
		n, err := strconv.Atoi(tz)
		if err != nil || n < -14*60 || n > 14*60 {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "tz must be minutes east of UTC"})
			return Query{}, false
		}
		q.TZOffsetMin = n
	}
	if g := strings.TrimSpace(c.Query("group")); g != "" && g != "none" {
		q.Group = strings.Split(g, ",")
	}
	for _, d := range allDims {
		if v := c.Query(d); v != "" {
			q.Filters[d] = v
		}
	}
	if l, err := strconv.Atoi(c.Query("limit")); err == nil {
		q.Limit = l
	}
	return q, true
}

func (h *handler) summary(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	q, ok := parseQuery(c, 24*time.Hour)
	if !ok {
		return
	}
	res, err := s.Summary(q)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *handler) timeseries(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	q, ok := parseQuery(c, 24*time.Hour)
	if !ok {
		return
	}
	res, err := s.Timeseries(q)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *handler) windows(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	dim := c.DefaultQuery("dim", DimAccount)
	res, err := s.Windows(dim)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func eventFilter(c *gin.Context) EventFilter {
	f := EventFilter{Filters: map[string]string{}, FailedOnly: c.Query("failed") == "true" || c.Query("failed") == "1"}
	f.Before, _ = parseTime(c.Query("before"), 0)
	f.From, _ = parseTime(c.Query("from"), 0)
	f.Limit, _ = strconv.Atoi(c.Query("limit"))
	for _, d := range allDims {
		if v := c.Query(d); v != "" {
			f.Filters[d] = v
		}
	}
	return f
}

func (h *handler) events(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	list, err := s.Events(eventFilter(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"events": list})
}

func (h *handler) live(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	res, err := s.Live()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *handler) exportCSV(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	q, ok := parseQuery(c, 7*24*time.Hour)
	if !ok {
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="usage.csv"`)
	w := csv.NewWriter(c.Writer)
	_ = w.Write([]string{"time", "key", "key_label", "provider", "account", "model", "stream", "input", "output", "reasoning", "cache_read", "cache_creation", "total", "latency_ms", "ttft_ms", "failed", "status"})
	_ = s.scanEvents(q.From, q.To, func(e *Event) bool {
		for d, v := range q.Filters {
			if e.dimValue(d) != v {
				return true
			}
		}
		label := ""
		if l, okLabel := s.Label(e.Key); okLabel {
			label = l.Label
		}
		_ = w.Write([]string{
			time.UnixMilli(e.TS).UTC().Format(time.RFC3339), e.Key, label, e.Provider, e.AuthID, e.Model,
			strconv.FormatBool(e.Stream), i64(e.Input), i64(e.Output), i64(e.Reasoning), i64(e.CacheRead),
			i64(e.CacheCreation), i64(e.Total), i64(e.LatencyMs), i64(e.TTFTMs), strconv.FormatBool(e.Failed),
			strconv.Itoa(e.Status),
		})
		return true
	})
	w.Flush()
}

func i64(v int64) string { return strconv.FormatInt(v, 10) }

func (h *handler) listKeys(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"keys": s.Labels()})
}

// putKey labels a key. :key is either a fingerprint or, with ?raw=1, the API
// key itself (fingerprinted server-side and not stored).
func (h *handler) putKey(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	var body struct {
		Label  string `json:"label"`
		Env    string `json:"env"`
		APIKey string `json:"api_key"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	key := c.Param("key")
	if body.APIKey != "" {
		key = Fingerprint(body.APIKey)
	}
	if len(key) != 16 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "key must be a 16-character fingerprint"})
		return
	}
	l := KeyLabel{Key: key, Label: strings.TrimSpace(body.Label), Env: strings.TrimSpace(body.Env)}
	if l.Label == "" {
		l.Label = l.Env
	}
	if err := s.SetLabel(l); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	saved, _ := s.Label(key)
	c.JSON(http.StatusOK, saved)
}

func (h *handler) deleteKey(c *gin.Context) {
	s := h.store(c)
	if s == nil {
		return
	}
	if err := s.DeleteLabel(c.Param("key")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type deviceSession struct {
	ID              string    `json:"id"`
	UserCode        string    `json:"user_code"`
	VerificationURL string    `json:"verification_url"`
	ExpiresAt       time.Time `json:"expires_at"`
	Status          string    `json:"status"` // wait | ok | error | cancelled
	Error           string    `json:"error,omitempty"`
	Email           string    `json:"email,omitempty"`
	File            string    `json:"file,omitempty"`
	cancel          context.CancelFunc
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *handler) startDevice(c *gin.Context) {
	code, err := sdkAuth.RequestCodexDeviceCode(c.Request.Context(), h.cfg)
	if err != nil {
		log.WithError(err).Warn("t3ext: codex device code request failed")
		c.JSON(http.StatusBadGateway, gin.H{"error": "could not start ChatGPT device sign-in"})
		return
	}
	ctx, cancel := context.WithDeadline(context.Background(), code.ExpiresAt)
	sess := &deviceSession{
		ID: randomID(), UserCode: code.UserCode, VerificationURL: code.VerificationURL,
		ExpiresAt: code.ExpiresAt, Status: "wait", cancel: cancel,
	}
	h.mu.Lock()
	h.devices[sess.ID] = sess
	h.mu.Unlock()

	go func() {
		defer cancel()
		record, errLogin := sdkAuth.CompleteCodexDeviceLogin(ctx, h.cfg, code)
		var saved string
		if errLogin == nil {
			saved, errLogin = sdkAuth.SaveLoginRecord(ctx, h.cfg, record)
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if sess.Status == "cancelled" {
			return
		}
		if errLogin != nil {
			sess.Status, sess.Error = "error", errLogin.Error()
			return
		}
		sess.Status, sess.File = "ok", saved
		if record != nil && record.Metadata != nil {
			if email, ok := record.Metadata["email"].(string); ok {
				sess.Email = email
			}
		}
	}()
	c.JSON(http.StatusOK, sess)
}

func (h *handler) deviceStatus(c *gin.Context) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sess, ok := h.devices[c.Param("id")]
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown session"})
		return
	}
	c.JSON(http.StatusOK, sess)
}

func (h *handler) cancelDevice(c *gin.Context) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if sess, ok := h.devices[c.Param("id")]; ok {
		if sess.Status == "wait" {
			sess.Status = "cancelled"
		}
		sess.cancel()
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
