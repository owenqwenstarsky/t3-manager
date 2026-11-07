// Package t3ext holds T3 Manager's additions to CLIProxyAPI: persistent usage
// analytics, environment-labelled client keys and a Codex device-code login API.
// It lives in its own package so upstream merges stay conflict-free.
package t3ext

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"
	"go.etcd.io/bbolt"
)

var (
	bucketEvents = []byte("events")
	bucketHourly = []byte("hourly")
	bucketKeys   = []byte("keys")
)

// Dimensions an event can be grouped or filtered by.
const (
	DimKey      = "key"
	DimAccount  = "account"
	DimModel    = "model"
	DimProvider = "provider"
)

var allDims = []string{DimKey, DimAccount, DimModel, DimProvider}

// rollupCombos lists the dimension sets that hourly rollups are kept for.
// Each entry is sorted. The empty set is the overall total.
var rollupCombos = [][]string{
	{},
	{DimKey},
	{DimAccount},
	{DimModel},
	{DimProvider},
	{DimKey, DimModel},
	{DimAccount, DimModel},
	{DimAccount, DimKey},
	{DimModel, DimProvider},
}

// Event is one upstream model execution as stored by t3ext.
type Event struct {
	TS            int64  `json:"ts"` // unix milliseconds
	ID            string `json:"id"`
	Key           string `json:"key,omitempty"` // client key fingerprint, never the key itself
	Provider      string `json:"provider,omitempty"`
	AuthID        string `json:"auth_id,omitempty"`
	AuthIndex     string `json:"auth_index,omitempty"`
	Model         string `json:"model,omitempty"`
	Alias         string `json:"alias,omitempty"`
	SessionID     string `json:"session_id,omitempty"`
	Stream        bool   `json:"stream,omitempty"`
	Input         int64  `json:"input"`
	Output        int64  `json:"output"`
	Reasoning     int64  `json:"reasoning,omitempty"`
	CacheRead     int64  `json:"cache_read,omitempty"`
	CacheCreation int64  `json:"cache_creation,omitempty"`
	Total         int64  `json:"total"`
	LatencyMs     int64  `json:"latency_ms"`
	TTFTMs        int64  `json:"ttft_ms,omitempty"`
	Failed        bool   `json:"failed,omitempty"`
	Status        int    `json:"status,omitempty"`
	FailCode      string `json:"fail_code,omitempty"`
}

// dimValue returns the event's value for a dimension.
func (e *Event) dimValue(dim string) string {
	var v string
	switch dim {
	case DimKey:
		v = e.Key
	case DimAccount:
		v = e.AuthID
	case DimModel:
		v = e.Model
	case DimProvider:
		v = e.Provider
	}
	if v == "" {
		return "unknown"
	}
	return v
}

// latencyBounds are the upper bounds (ms) of the latency histogram buckets.
// The last bucket is open-ended.
var latencyBounds = []int64{250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000}

// LatencyBuckets is len(latencyBounds)+1.
const LatencyBuckets = 12

// Agg is an additive usage aggregate.
type Agg struct {
	Requests      int64                 `json:"requests"`
	Failures      int64                 `json:"failures"`
	Input         int64                 `json:"input"`
	Output        int64                 `json:"output"`
	Reasoning     int64                 `json:"reasoning"`
	CacheRead     int64                 `json:"cache_read"`
	CacheCreation int64                 `json:"cache_creation"`
	Total         int64                 `json:"total"`
	Streams       int64                 `json:"streams"`
	LatencySumMs  int64                 `json:"latency_sum_ms"`
	LatencyMaxMs  int64                 `json:"latency_max_ms"`
	TTFTSumMs     int64                 `json:"ttft_sum_ms"`
	TTFTCount     int64                 `json:"ttft_count"`
	LatencyHist   [LatencyBuckets]int64 `json:"latency_hist"`
}

func (a *Agg) addEvent(e *Event) {
	a.Requests++
	if e.Failed {
		a.Failures++
	}
	a.Input += e.Input
	a.Output += e.Output
	a.Reasoning += e.Reasoning
	a.CacheRead += e.CacheRead
	a.CacheCreation += e.CacheCreation
	a.Total += e.Total
	if e.Stream {
		a.Streams++
	}
	a.LatencySumMs += e.LatencyMs
	if e.LatencyMs > a.LatencyMaxMs {
		a.LatencyMaxMs = e.LatencyMs
	}
	if e.TTFTMs > 0 {
		a.TTFTSumMs += e.TTFTMs
		a.TTFTCount++
	}
	a.LatencyHist[latencyBucket(e.LatencyMs)]++
}

func (a *Agg) merge(b *Agg) {
	a.Requests += b.Requests
	a.Failures += b.Failures
	a.Input += b.Input
	a.Output += b.Output
	a.Reasoning += b.Reasoning
	a.CacheRead += b.CacheRead
	a.CacheCreation += b.CacheCreation
	a.Total += b.Total
	a.Streams += b.Streams
	a.LatencySumMs += b.LatencySumMs
	if b.LatencyMaxMs > a.LatencyMaxMs {
		a.LatencyMaxMs = b.LatencyMaxMs
	}
	a.TTFTSumMs += b.TTFTSumMs
	a.TTFTCount += b.TTFTCount
	for i := range a.LatencyHist {
		a.LatencyHist[i] += b.LatencyHist[i]
	}
}

func latencyBucket(ms int64) int {
	for i, bound := range latencyBounds {
		if ms <= bound {
			return i
		}
	}
	return len(latencyBounds)
}

// Percentile estimates a latency percentile (0-1) from the histogram, in ms.
func (a *Agg) Percentile(p float64) int64 {
	var total int64
	for _, c := range a.LatencyHist {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := int64(float64(total)*p + 0.5)
	if target < 1 {
		target = 1
	}
	var seen int64
	for i, c := range a.LatencyHist {
		seen += c
		if seen >= target {
			if i < len(latencyBounds) {
				return latencyBounds[i]
			}
			return a.LatencyMaxMs
		}
	}
	return a.LatencyMaxMs
}

// KeyLabel names a client API key, normally after the T3 environment using it.
type KeyLabel struct {
	Key       string `json:"key"` // fingerprint
	Label     string `json:"label"`
	Env       string `json:"env,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

// Retention controls how long data is kept.
type Retention struct {
	Events time.Duration
	Hourly time.Duration
}

// Store persists usage events and rollups in a bbolt database.
type Store struct {
	db        *bbolt.DB
	retention Retention
	now       func() time.Time

	labelsMu sync.RWMutex
	labels   map[string]KeyLabel
}

// OpenStore opens (or creates) the usage database under dir.
func OpenStore(dir string, retention Retention) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("t3ext: create data dir: %w", err)
	}
	db, err := bbolt.Open(filepath.Join(dir, "usage.db"), 0o600, &bbolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("t3ext: open usage db: %w", err)
	}
	if err = db.Update(func(tx *bbolt.Tx) error {
		for _, b := range [][]byte{bucketEvents, bucketHourly, bucketKeys} {
			if _, errCreate := tx.CreateBucketIfNotExists(b); errCreate != nil {
				return errCreate
			}
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("t3ext: init buckets: %w", err)
	}
	s := &Store{db: db, retention: retention, now: time.Now, labels: map[string]KeyLabel{}}
	if err = s.loadLabels(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func eventKey(ts int64, id string) []byte {
	k := make([]byte, 8, 8+len(id))
	binary.BigEndian.PutUint64(k, uint64(ts))
	return append(k, id...)
}

func hourStart(tsMs int64) int64 {
	return tsMs - mod(tsMs, int64(time.Hour/time.Millisecond))
}

func mod(a, b int64) int64 {
	m := a % b
	if m < 0 {
		m += b
	}
	return m
}

// rollupKey encodes hour start + combo + values. Values are in combo order.
func rollupKey(hour int64, combo []string, values []string) []byte {
	var buf bytes.Buffer
	var ts [8]byte
	binary.BigEndian.PutUint64(ts[:], uint64(hour))
	buf.Write(ts[:])
	buf.WriteString(strings.Join(combo, ","))
	for _, v := range values {
		buf.WriteByte(0)
		buf.WriteString(v)
	}
	return buf.Bytes()
}

func parseRollupKey(k []byte) (hour int64, combo string, values []string, ok bool) {
	if len(k) < 8 {
		return 0, "", nil, false
	}
	hour = int64(binary.BigEndian.Uint64(k[:8]))
	parts := strings.Split(string(k[8:]), "\x00")
	return hour, parts[0], parts[1:], true
}

// Record stores an event and updates every rollup it contributes to.
func (s *Store) Record(e Event) error {
	if e.TS == 0 {
		e.TS = s.now().UnixMilli()
	}
	raw, err := json.Marshal(&e)
	if err != nil {
		return err
	}
	hour := hourStart(e.TS)
	return s.db.Batch(func(tx *bbolt.Tx) error {
		if errPut := tx.Bucket(bucketEvents).Put(eventKey(e.TS, e.ID), raw); errPut != nil {
			return errPut
		}
		hb := tx.Bucket(bucketHourly)
		for _, combo := range rollupCombos {
			values := make([]string, len(combo))
			for i, d := range combo {
				values[i] = e.dimValue(d)
			}
			k := rollupKey(hour, combo, values)
			var agg Agg
			if existing := hb.Get(k); existing != nil {
				if errDecode := json.Unmarshal(existing, &agg); errDecode != nil {
					log.WithError(errDecode).Warn("t3ext: resetting corrupt rollup")
					agg = Agg{}
				}
			}
			agg.addEvent(&e)
			encoded, errEncode := json.Marshal(&agg)
			if errEncode != nil {
				return errEncode
			}
			if errPut := hb.Put(k, encoded); errPut != nil {
				return errPut
			}
		}
		return nil
	})
}

// scanEvents calls fn for events with from <= ts < to, oldest first.
func (s *Store) scanEvents(from, to int64, fn func(e *Event) bool) error {
	return s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucketEvents).Cursor()
		start := eventKey(from, "")
		for k, v := c.Seek(start); k != nil; k, v = c.Next() {
			if len(k) < 8 || int64(binary.BigEndian.Uint64(k[:8])) >= to {
				break
			}
			var e Event
			if err := json.Unmarshal(v, &e); err != nil {
				continue
			}
			if !fn(&e) {
				break
			}
		}
		return nil
	})
}

// scanEventsDesc calls fn for events with ts < before, newest first.
func (s *Store) scanEventsDesc(before int64, fn func(e *Event) bool) error {
	return s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucketEvents).Cursor()
		k, v := c.Seek(eventKey(before, ""))
		if k == nil {
			k, v = c.Last()
		} else {
			k, v = c.Prev()
		}
		for ; k != nil; k, v = c.Prev() {
			if len(k) >= 8 && int64(binary.BigEndian.Uint64(k[:8])) >= before {
				continue
			}
			var e Event
			if err := json.Unmarshal(v, &e); err != nil {
				continue
			}
			if !fn(&e) {
				break
			}
		}
		return nil
	})
}

// scanRollups calls fn for rollups of one combo with from <= hour < to.
func (s *Store) scanRollups(combo []string, from, to int64, fn func(hour int64, values []string, a *Agg)) error {
	comboName := strings.Join(combo, ",")
	return s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucketHourly).Cursor()
		var start [8]byte
		binary.BigEndian.PutUint64(start[:], uint64(hourStart(from)))
		for k, v := c.Seek(start[:]); k != nil; k, v = c.Next() {
			hour, name, values, ok := parseRollupKey(k)
			if !ok {
				continue
			}
			if hour >= to {
				break
			}
			if name != comboName || hour < from {
				continue
			}
			var a Agg
			if err := json.Unmarshal(v, &a); err != nil {
				continue
			}
			fn(hour, values, &a)
		}
		return nil
	})
}

// OldestEvent returns the timestamp of the oldest stored raw event, or 0.
func (s *Store) OldestEvent() int64 {
	var ts int64
	_ = s.db.View(func(tx *bbolt.Tx) error {
		k, _ := tx.Bucket(bucketEvents).Cursor().First()
		if len(k) >= 8 {
			ts = int64(binary.BigEndian.Uint64(k[:8]))
		}
		return nil
	})
	return ts
}

// Prune deletes events and rollups older than the retention windows.
func (s *Store) Prune() (events, rollups int, err error) {
	now := s.now()
	err = s.db.Update(func(tx *bbolt.Tx) error {
		if s.retention.Events > 0 {
			cutoff := eventKey(now.Add(-s.retention.Events).UnixMilli(), "")
			c := tx.Bucket(bucketEvents).Cursor()
			for k, _ := c.First(); k != nil && bytes.Compare(k, cutoff) < 0; k, _ = c.Next() {
				if errDel := c.Delete(); errDel != nil {
					return errDel
				}
				events++
			}
		}
		if s.retention.Hourly > 0 {
			var cutoff [8]byte
			binary.BigEndian.PutUint64(cutoff[:], uint64(hourStart(now.Add(-s.retention.Hourly).UnixMilli())))
			c := tx.Bucket(bucketHourly).Cursor()
			for k, _ := c.First(); k != nil && bytes.Compare(k[:8], cutoff[:]) < 0; k, _ = c.Next() {
				if errDel := c.Delete(); errDel != nil {
					return errDel
				}
				rollups++
			}
		}
		return nil
	})
	return events, rollups, err
}

func (s *Store) loadLabels() error {
	return s.db.View(func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketKeys).ForEach(func(k, v []byte) error {
			var l KeyLabel
			if err := json.Unmarshal(v, &l); err == nil {
				s.labels[string(k)] = l
			}
			return nil
		})
	})
}

// Labels returns all key labels sorted by label.
func (s *Store) Labels() []KeyLabel {
	s.labelsMu.RLock()
	out := make([]KeyLabel, 0, len(s.labels))
	for _, l := range s.labels {
		out = append(out, l)
	}
	s.labelsMu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

// Label returns the label for a key fingerprint.
func (s *Store) Label(key string) (KeyLabel, bool) {
	s.labelsMu.RLock()
	defer s.labelsMu.RUnlock()
	l, ok := s.labels[key]
	return l, ok
}

// SetLabel creates or updates a key label.
func (s *Store) SetLabel(l KeyLabel) error {
	if l.Key == "" {
		return errors.New("key fingerprint is required")
	}
	if existing, ok := s.Label(l.Key); ok && l.CreatedAt == 0 {
		l.CreatedAt = existing.CreatedAt
	}
	if l.CreatedAt == 0 {
		l.CreatedAt = s.now().UnixMilli()
	}
	raw, err := json.Marshal(&l)
	if err != nil {
		return err
	}
	if err = s.db.Update(func(tx *bbolt.Tx) error { return tx.Bucket(bucketKeys).Put([]byte(l.Key), raw) }); err != nil {
		return err
	}
	s.labelsMu.Lock()
	s.labels[l.Key] = l
	s.labelsMu.Unlock()
	return nil
}

// DeleteLabel removes a key label. Usage history is kept.
func (s *Store) DeleteLabel(key string) error {
	if err := s.db.Update(func(tx *bbolt.Tx) error { return tx.Bucket(bucketKeys).Delete([]byte(key)) }); err != nil {
		return err
	}
	s.labelsMu.Lock()
	delete(s.labels, key)
	s.labelsMu.Unlock()
	return nil
}
