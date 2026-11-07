package t3ext

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	msMinute = int64(time.Minute / time.Millisecond)
	msHour   = int64(time.Hour / time.Millisecond)
	msDay    = 24 * msHour
	msWeek   = 7 * msDay
	// maxPoints bounds the size of one time series.
	maxPoints = 5000
)

// Steps maps step names to bucket widths in milliseconds.
var Steps = map[string]int64{
	"minute": msMinute,
	"5m":     5 * msMinute,
	"15m":    15 * msMinute,
	"hour":   msHour,
	"6h":     6 * msHour,
	"day":    msDay,
	"week":   msWeek,
}

// AutoStep picks a step that gives a readable number of points for a window.
func AutoStep(windowMs int64) string {
	switch {
	case windowMs <= 2*msHour:
		return "minute"
	case windowMs <= 8*msHour:
		return "5m"
	case windowMs <= 2*msDay:
		return "hour"
	case windowMs <= 14*msDay:
		return "6h"
	case windowMs <= 120*msDay:
		return "day"
	default:
		return "week"
	}
}

// Metrics is the client-facing form of an Agg, with derived values.
type Metrics struct {
	Requests      int64   `json:"requests"`
	Failures      int64   `json:"failures"`
	ErrorRate     float64 `json:"error_rate"`
	Input         int64   `json:"input"`
	Output        int64   `json:"output"`
	Reasoning     int64   `json:"reasoning"`
	CacheRead     int64   `json:"cache_read"`
	CacheCreation int64   `json:"cache_creation"`
	Total         int64   `json:"total"`
	CacheHitRate  float64 `json:"cache_hit_rate"`
	Streams       int64   `json:"streams"`
	AvgLatencyMs  int64   `json:"avg_latency_ms"`
	P50LatencyMs  int64   `json:"p50_latency_ms"`
	P95LatencyMs  int64   `json:"p95_latency_ms"`
	MaxLatencyMs  int64   `json:"max_latency_ms"`
	AvgTTFTMs     int64   `json:"avg_ttft_ms"`
}

// ToMetrics converts an aggregate into Metrics.
func (a *Agg) ToMetrics() Metrics {
	m := Metrics{
		Requests:      a.Requests,
		Failures:      a.Failures,
		Input:         a.Input,
		Output:        a.Output,
		Reasoning:     a.Reasoning,
		CacheRead:     a.CacheRead,
		CacheCreation: a.CacheCreation,
		Total:         a.Total,
		Streams:       a.Streams,
		MaxLatencyMs:  a.LatencyMaxMs,
	}
	if a.Requests > 0 {
		m.ErrorRate = float64(a.Failures) / float64(a.Requests)
		m.AvgLatencyMs = a.LatencySumMs / a.Requests
		m.P50LatencyMs = min(a.Percentile(0.50), a.LatencyMaxMs)
		m.P95LatencyMs = min(a.Percentile(0.95), a.LatencyMaxMs)
	}
	if a.TTFTCount > 0 {
		m.AvgTTFTMs = a.TTFTSumMs / a.TTFTCount
	}
	// Input reported by Anthropic excludes cache reads; OpenAI includes cached
	// tokens in input. Use reads / (input + reads) as a provider-neutral ratio.
	if denom := a.Input + a.CacheRead; denom > 0 {
		m.CacheHitRate = float64(a.CacheRead) / float64(denom)
	}
	return m
}

// Query describes a usage query.
type Query struct {
	From        int64             // unix ms, inclusive
	To          int64             // unix ms, exclusive
	Step        string            // see Steps; empty picks AutoStep
	TZOffsetMin int               // minutes east of UTC, aligns day/week buckets
	Group       []string          // 0-2 dimensions
	Filters     map[string]string // dimension -> value
	Limit       int               // max series; the rest are merged into "other"
}

func (q *Query) validate() error {
	if q.To <= q.From {
		return errors.New("to must be after from")
	}
	if len(q.Group) > 2 {
		return errors.New("group by at most two dimensions")
	}
	seen := map[string]bool{}
	for _, d := range q.Group {
		if !isDim(d) {
			return fmt.Errorf("unknown dimension %q", d)
		}
		if seen[d] {
			return fmt.Errorf("duplicate dimension %q", d)
		}
		seen[d] = true
	}
	for d := range q.Filters {
		if !isDim(d) {
			return fmt.Errorf("unknown filter dimension %q", d)
		}
	}
	return nil
}

func isDim(d string) bool {
	for _, x := range allDims {
		if x == d {
			return true
		}
	}
	return false
}

// combo returns the sorted set of dimensions a query needs.
func (q *Query) combo() []string {
	set := map[string]bool{}
	for _, d := range q.Group {
		set[d] = true
	}
	for d := range q.Filters {
		set[d] = true
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

func hasRollup(combo []string) bool {
	for _, c := range rollupCombos {
		if strings.Join(c, ",") == strings.Join(combo, ",") {
			return true
		}
	}
	return false
}

// collect feeds every matching aggregate in [from, to) to add, using hourly
// rollups for whole hours when the combo has them and raw events otherwise.
// It reports which source was used.
func (s *Store) collect(from, to int64, combo []string, useRollups bool, add func(ts int64, values []string, a *Agg)) (string, error) {
	rawRange := func(f, t int64) error {
		if f >= t {
			return nil
		}
		return s.scanEvents(f, t, func(e *Event) bool {
			values := make([]string, len(combo))
			for i, d := range combo {
				values[i] = e.dimValue(d)
			}
			var a Agg
			a.addEvent(e)
			add(e.TS, values, &a)
			return true
		})
	}
	if !useRollups || !hasRollup(combo) {
		return "events", rawRange(from, to)
	}
	firstHour := hourStart(from)
	if firstHour < from {
		firstHour += msHour
	}
	lastHour := hourStart(to)
	if firstHour >= lastHour {
		return "events", rawRange(from, to)
	}
	if err := rawRange(from, firstHour); err != nil {
		return "", err
	}
	if err := s.scanRollups(combo, firstHour, lastHour, func(hour int64, values []string, a *Agg) {
		add(hour, values, a)
	}); err != nil {
		return "", err
	}
	if err := rawRange(lastHour, to); err != nil {
		return "", err
	}
	return "rollups", nil
}

// bucketStart aligns ts to a step, honouring the timezone for day/week steps.
func bucketStart(ts, step int64, tzOffsetMin int) int64 {
	if step < msDay {
		return ts - mod(ts, step)
	}
	shift := int64(tzOffsetMin) * msMinute
	if step == msWeek {
		// The Unix epoch was a Thursday; shift so weeks start on Monday.
		shift += 3 * msDay
	}
	return ts - mod(ts+shift, step)
}

// Point is one time bucket.
type Point struct {
	T int64 `json:"t"`
	Metrics
}

// Series is one group's time series.
type Series struct {
	Group  map[string]string `json:"group"`
	Labels map[string]string `json:"labels,omitempty"`
	Total  Metrics           `json:"total"`
	Points []Point           `json:"points"`
}

// TimeseriesResult is the response of Timeseries.
type TimeseriesResult struct {
	From   int64    `json:"from"`
	To     int64    `json:"to"`
	Step   string   `json:"step"`
	StepMs int64    `json:"step_ms"`
	Source string   `json:"source"`
	Group  []string `json:"group"`
	Total  Metrics  `json:"total"`
	Series []Series `json:"series"`
	// DataFrom is set when raw events were needed and the window starts before
	// the oldest retained event.
	DataFrom int64 `json:"data_from,omitempty"`
}

type seriesAcc struct {
	values []string
	total  Agg
	points map[int64]*Agg
}

// Timeseries returns usage over time, optionally split into groups.
func (s *Store) Timeseries(q Query) (*TimeseriesResult, error) {
	if err := q.validate(); err != nil {
		return nil, err
	}
	if q.Step == "" {
		q.Step = AutoStep(q.To - q.From)
	}
	step, ok := Steps[q.Step]
	if !ok {
		return nil, fmt.Errorf("unknown step %q", q.Step)
	}
	if (q.To-q.From)/step > maxPoints {
		return nil, fmt.Errorf("too many points; use a larger step")
	}
	if q.Limit <= 0 {
		q.Limit = 12
	}
	combo := q.combo()
	groupIdx := make([]int, len(q.Group))
	for i, g := range q.Group {
		for j, c := range combo {
			if c == g {
				groupIdx[i] = j
			}
		}
	}
	filterIdx := map[int]string{}
	for d, v := range q.Filters {
		for j, c := range combo {
			if c == d {
				filterIdx[j] = v
			}
		}
	}
	// Rollups line up with buckets only for hour-or-larger steps and whole-hour offsets.
	useRollups := step >= msHour && q.TZOffsetMin%60 == 0

	accs := map[string]*seriesAcc{}
	var overall Agg
	source, err := s.collect(q.From, q.To, combo, useRollups, func(ts int64, values []string, a *Agg) {
		for idx, want := range filterIdx {
			if values[idx] != want {
				return
			}
		}
		gv := make([]string, len(groupIdx))
		for i, idx := range groupIdx {
			gv[i] = values[idx]
		}
		key := strings.Join(gv, "\x00")
		acc := accs[key]
		if acc == nil {
			acc = &seriesAcc{values: gv, points: map[int64]*Agg{}}
			accs[key] = acc
		}
		b := bucketStart(ts, step, q.TZOffsetMin)
		p := acc.points[b]
		if p == nil {
			p = &Agg{}
			acc.points[b] = p
		}
		p.merge(a)
		acc.total.merge(a)
		overall.merge(a)
	})
	if err != nil {
		return nil, err
	}

	list := make([]*seriesAcc, 0, len(accs))
	for _, a := range accs {
		list = append(list, a)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].total.Total != list[j].total.Total {
			return list[i].total.Total > list[j].total.Total
		}
		return list[i].total.Requests > list[j].total.Requests
	})
	if len(list) > q.Limit && len(q.Group) > 0 {
		other := &seriesAcc{values: make([]string, len(q.Group)), points: map[int64]*Agg{}}
		for i := range other.values {
			other.values[i] = "other"
		}
		for _, a := range list[q.Limit-1:] {
			other.total.merge(&a.total)
			for t, p := range a.points {
				if other.points[t] == nil {
					other.points[t] = &Agg{}
				}
				other.points[t].merge(p)
			}
		}
		list = append(list[:q.Limit-1], other)
	}

	res := &TimeseriesResult{
		From: q.From, To: q.To, Step: q.Step, StepMs: step, Source: source,
		Group: q.Group, Total: overall.ToMetrics(), Series: []Series{},
	}
	if source == "events" {
		if oldest := s.OldestEvent(); oldest > q.From {
			res.DataFrom = oldest
		}
	}
	first := bucketStart(q.From, step, q.TZOffsetMin)
	for _, a := range list {
		ser := Series{Group: map[string]string{}, Total: a.total.ToMetrics(), Points: []Point{}}
		for i, g := range q.Group {
			ser.Group[g] = a.values[i]
			if g == DimKey {
				if l, okLabel := s.Label(a.values[i]); okLabel {
					if ser.Labels == nil {
						ser.Labels = map[string]string{}
					}
					ser.Labels[g] = l.Label
				}
			}
		}
		// Emit every bucket, zero-filled, so charts need no gap handling.
		for t := first; t < q.To; t += step {
			b := bucketStart(t, step, q.TZOffsetMin)
			pt := Point{T: b}
			if p := a.points[b]; p != nil {
				pt.Metrics = p.ToMetrics()
			}
			ser.Points = append(ser.Points, pt)
		}
		res.Series = append(res.Series, ser)
	}
	return res, nil
}

// Row is one entry of a breakdown.
type Row struct {
	Value    string  `json:"value"`
	Label    string  `json:"label,omitempty"`
	Share    float64 `json:"share"` // share of total tokens
	Metrics  Metrics `json:"metrics"`
	Previous Metrics `json:"previous"`
}

// SummaryResult is the response of Summary.
type SummaryResult struct {
	From      int64            `json:"from"`
	To        int64            `json:"to"`
	Total     Metrics          `json:"total"`
	Previous  Metrics          `json:"previous"` // same-length window just before From
	Breakdown map[string][]Row `json:"breakdown"`
}

// Summary returns totals, the previous-period comparison and per-dimension
// breakdowns for a window. Filters narrow everything.
func (s *Store) Summary(q Query) (*SummaryResult, error) {
	q.Group = nil
	if err := q.validate(); err != nil {
		return nil, err
	}
	window := q.To - q.From
	res := &SummaryResult{From: q.From, To: q.To, Breakdown: map[string][]Row{}}

	for _, dim := range allDims {
		sub := q
		sub.Group = []string{dim}
		cur, err := s.groupTotals(sub, q.From, q.To)
		if err != nil {
			return nil, err
		}
		prev, err := s.groupTotals(sub, q.From-window, q.From)
		if err != nil {
			return nil, err
		}
		var grand int64
		for _, a := range cur {
			grand += a.Total
		}
		rows := make([]Row, 0, len(cur))
		for v, a := range cur {
			r := Row{Value: v, Metrics: a.ToMetrics()}
			if p, ok := prev[v]; ok {
				r.Previous = p.ToMetrics()
			}
			if grand > 0 {
				r.Share = float64(a.Total) / float64(grand)
			}
			if dim == DimKey {
				if l, ok := s.Label(v); ok {
					r.Label = l.Label
				}
			}
			rows = append(rows, r)
		}
		sort.Slice(rows, func(i, j int) bool {
			if rows[i].Metrics.Total != rows[j].Metrics.Total {
				return rows[i].Metrics.Total > rows[j].Metrics.Total
			}
			return rows[i].Metrics.Requests > rows[j].Metrics.Requests
		})
		res.Breakdown[dim] = rows
	}

	total, err := s.groupTotals(q, q.From, q.To)
	if err != nil {
		return nil, err
	}
	prevTotal, err := s.groupTotals(q, q.From-window, q.From)
	if err != nil {
		return nil, err
	}
	if t := total[""]; t != nil {
		res.Total = t.ToMetrics()
	}
	if p := prevTotal[""]; p != nil {
		res.Previous = p.ToMetrics()
	}
	return res, nil
}

// groupTotals aggregates [from, to) by the query's single group dimension
// (or into "" when ungrouped), honouring filters.
func (s *Store) groupTotals(q Query, from, to int64) (map[string]*Agg, error) {
	combo := q.combo()
	gi := -1
	if len(q.Group) == 1 {
		for j, c := range combo {
			if c == q.Group[0] {
				gi = j
			}
		}
	}
	filterIdx := map[int]string{}
	for d, v := range q.Filters {
		for j, c := range combo {
			if c == d {
				filterIdx[j] = v
			}
		}
	}
	out := map[string]*Agg{}
	_, err := s.collect(from, to, combo, true, func(_ int64, values []string, a *Agg) {
		for idx, want := range filterIdx {
			if values[idx] != want {
				return
			}
		}
		k := ""
		if gi >= 0 {
			k = values[gi]
		}
		if out[k] == nil {
			out[k] = &Agg{}
		}
		out[k].merge(a)
	})
	return out, err
}

// WindowsResult reports rolling-window usage for one dimension.
type WindowsResult struct {
	Dim     string                        `json:"dim"`
	Windows []string                      `json:"windows"`
	Values  map[string]map[string]Metrics `json:"values"` // value -> window -> metrics
	Labels  map[string]string             `json:"labels,omitempty"`
}

// RollingWindows are the windows reported by Windows, matching common
// subscription limits.
var RollingWindows = []struct {
	Name string
	Dur  time.Duration
}{
	{"1h", time.Hour},
	{"5h", 5 * time.Hour},
	{"24h", 24 * time.Hour},
	{"7d", 7 * 24 * time.Hour},
	{"30d", 30 * 24 * time.Hour},
}

// Windows reports usage over rolling windows ending now, per dimension value.
func (s *Store) Windows(dim string) (*WindowsResult, error) {
	if !isDim(dim) {
		return nil, fmt.Errorf("unknown dimension %q", dim)
	}
	now := s.now().UnixMilli()
	res := &WindowsResult{Dim: dim, Values: map[string]map[string]Metrics{}}
	for _, w := range RollingWindows {
		res.Windows = append(res.Windows, w.Name)
		totals, err := s.groupTotals(Query{Group: []string{dim}}, now-w.Dur.Milliseconds(), now+1)
		if err != nil {
			return nil, err
		}
		for v, a := range totals {
			if res.Values[v] == nil {
				res.Values[v] = map[string]Metrics{}
			}
			res.Values[v][w.Name] = a.ToMetrics()
		}
	}
	if dim == DimKey {
		res.Labels = map[string]string{}
		for v := range res.Values {
			if l, ok := s.Label(v); ok {
				res.Labels[v] = l.Label
			}
		}
	}
	return res, nil
}

// EventFilter narrows Events.
type EventFilter struct {
	Before     int64 // unix ms, exclusive; 0 means now
	Limit      int
	Filters    map[string]string
	FailedOnly bool
	From       int64
}

// EventView is an Event with its key label resolved.
type EventView struct {
	Event
	KeyLabel string `json:"key_label,omitempty"`
}

// Events returns recent raw events, newest first.
func (s *Store) Events(f EventFilter) ([]EventView, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	if f.Before <= 0 {
		f.Before = s.now().UnixMilli() + 1
	}
	out := make([]EventView, 0, f.Limit)
	err := s.scanEventsDesc(f.Before, func(e *Event) bool {
		if f.From > 0 && e.TS < f.From {
			return false
		}
		if f.FailedOnly && !e.Failed {
			return true
		}
		for d, v := range f.Filters {
			if e.dimValue(d) != v {
				return true
			}
		}
		ev := EventView{Event: *e}
		if l, ok := s.Label(e.Key); ok {
			ev.KeyLabel = l.Label
		}
		out = append(out, ev)
		return len(out) < f.Limit
	})
	return out, err
}

// LiveResult is a near-real-time snapshot.
type LiveResult struct {
	Now          int64   `json:"now"`
	LastMinute   Metrics `json:"last_minute"`
	Last5Minutes Metrics `json:"last_5_minutes"`
	Points       []Point `json:"points"` // per minute, last 60 minutes
	ActiveKeys   int     `json:"active_keys"`
	ActiveModels int     `json:"active_models"`
}

// Live returns the last hour per minute plus current rates.
func (s *Store) Live() (*LiveResult, error) {
	now := s.now().UnixMilli()
	start := bucketStart(now, msMinute, 0) - 59*msMinute
	buckets := map[int64]*Agg{}
	var lastMin, last5 Agg
	keys, models := map[string]bool{}, map[string]bool{}
	err := s.scanEvents(start, now+1, func(e *Event) bool {
		b := bucketStart(e.TS, msMinute, 0)
		if buckets[b] == nil {
			buckets[b] = &Agg{}
		}
		buckets[b].addEvent(e)
		if e.TS >= now-msMinute {
			lastMin.addEvent(e)
		}
		if e.TS >= now-5*msMinute {
			last5.addEvent(e)
			keys[e.Key] = true
			models[e.Model] = true
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	res := &LiveResult{
		Now: now, LastMinute: lastMin.ToMetrics(), Last5Minutes: last5.ToMetrics(),
		ActiveKeys: len(keys), ActiveModels: len(models),
	}
	for t := start; t <= now; t += msMinute {
		pt := Point{T: t}
		if a := buckets[t]; a != nil {
			pt.Metrics = a.ToMetrics()
		}
		res.Points = append(res.Points, pt)
	}
	return res, nil
}
