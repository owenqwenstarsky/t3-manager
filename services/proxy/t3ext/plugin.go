package t3ext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
)

var (
	storeOnce sync.Once
	store     *Store
	storeErr  error
)

func init() {
	coreusage.RegisterPlugin(&usagePlugin{})
}

// Enabled reports whether t3ext is switched on (T3EXT_ENABLED, default true).
func Enabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("T3EXT_ENABLED")))
	return v != "0" && v != "false" && v != "no"
}

// DataDir is where t3ext keeps its database (T3EXT_DATA_DIR).
func DataDir() string {
	if dir := strings.TrimSpace(os.Getenv("T3EXT_DATA_DIR")); dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".cli-proxy-api", "t3ext")
	}
	return "t3ext-data"
}

func envDays(name string, def int) time.Duration {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v >= 0 {
		def = v
	}
	return time.Duration(def) * 24 * time.Hour
}

// SharedStore opens the process-wide store on first use.
func SharedStore() (*Store, error) {
	storeOnce.Do(func() {
		store, storeErr = OpenStore(DataDir(), Retention{
			Events: envDays("T3EXT_EVENT_RETENTION_DAYS", 45),
			Hourly: envDays("T3EXT_HOURLY_RETENTION_DAYS", 800),
		})
		if storeErr != nil {
			log.WithError(storeErr).Error("t3ext: usage store unavailable")
			return
		}
		go pruneLoop(store)
		log.Infof("t3ext: usage analytics stored in %s", DataDir())
	})
	return store, storeErr
}

func pruneLoop(s *Store) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if events, rollups, err := s.Prune(); err != nil {
			log.WithError(err).Warn("t3ext: prune failed")
		} else if events+rollups > 0 {
			log.Debugf("t3ext: pruned %d events and %d rollups", events, rollups)
		}
		<-ticker.C
	}
}

// Fingerprint returns the identifier stored for a client API key. The key
// itself is never written to disk.
func Fingerprint(apiKey string) string {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])[:16]
}

type usagePlugin struct{}

var (
	writerOnce sync.Once
	writerCh   chan Event
)

// Writes are batched: one transaction per flush keeps the proxy's usage
// dispatcher from waiting on disk for every request.
const (
	writerQueue    = 20000
	writerMaxBatch = 1000
	writerInterval = 250 * time.Millisecond
)

func startWriter(s *Store) {
	writerCh = make(chan Event, writerQueue)
	go func() {
		ticker := time.NewTicker(writerInterval)
		defer ticker.Stop()
		batch := make([]Event, 0, writerMaxBatch)
		flush := func() {
			if len(batch) == 0 {
				return
			}
			if err := s.RecordBatch(batch); err != nil {
				log.WithError(err).Warnf("t3ext: failed to record %d usage events", len(batch))
			}
			batch = batch[:0]
		}
		for {
			select {
			case e := <-writerCh:
				batch = append(batch, e)
				if len(batch) >= writerMaxBatch {
					flush()
				}
			case <-ticker.C:
				flush()
			}
		}
	}()
}

func (p *usagePlugin) HandleUsage(_ context.Context, record coreusage.Record) {
	if !Enabled() || !coreusage.GenerateEnabled(record.Generate) {
		return
	}
	s, err := SharedStore()
	if err != nil {
		return
	}
	writerOnce.Do(func() { startWriter(s) })
	select {
	case writerCh <- EventFromRecord(record):
	default:
		log.Warn("t3ext: usage queue full; dropping an event")
	}
}

// EventFromRecord converts an upstream usage record into a t3ext Event.
// Token fields are normalised: Input is uncached input, Output includes
// reasoning, and cache reads/writes are separate, whatever the provider.
func EventFromRecord(r coreusage.Record) Event {
	ts := r.RequestedAt
	if ts.IsZero() {
		ts = time.Now()
	}
	model := strings.TrimSpace(r.ResponseModel)
	if model == "" {
		model = strings.TrimSpace(r.Model)
	}
	e := Event{
		TS:        ts.UnixMilli(),
		ID:        r.RequestID,
		Key:       Fingerprint(r.APIKey),
		Provider:  strings.ToLower(strings.TrimSpace(r.Provider)),
		AuthID:    strings.TrimSpace(r.AuthID),
		AuthIndex: strings.TrimSpace(r.AuthIndex),
		Model:     model,
		Alias:     strings.TrimSpace(r.Alias),
		SessionID: strings.TrimSpace(r.SessionID),
		Stream:    r.Stream,
		LatencyMs: r.Latency.Milliseconds(),
		TTFTMs:    r.TTFT.Milliseconds(),
		Failed:    r.Failed,
		Status:    r.Fail.StatusCode,
		FailCode:  r.Fail.Code,
	}
	if e.ID == "" {
		e.ID = strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	d := r.Detail
	if b := d.TokenBreakdown; b.Valid() {
		e.Input = b.Input.UncachedTokens
		e.CacheRead = b.Input.CacheReadTokens
		e.CacheCreation = b.Input.CacheWriteTokens
		e.Output = b.Output.TotalTokens
		e.Reasoning = b.Output.ReasoningTokens
		e.Total = b.TotalTokens
		if e.Total == 0 {
			e.Total = b.Input.TotalTokens + b.Output.TotalTokens + b.UnclassifiedTokens
		}
		return e
	}
	// Fallback for records without a valid breakdown.
	e.Input = d.InputTokens
	e.Output = d.OutputTokens
	e.Reasoning = d.ReasoningTokens
	e.CacheRead = d.CacheReadTokens
	e.CacheCreation = d.CacheCreationTokens
	e.Total = d.TotalTokens
	if e.Total == 0 {
		e.Total = e.Input + e.Output + e.CacheRead + e.CacheCreation
	}
	return e
}
