package t3ext

import (
	"testing"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func newTestStore(t *testing.T, now time.Time) *Store {
	t.Helper()
	s, err := OpenStore(t.TempDir(), Retention{Events: 30 * 24 * time.Hour, Hourly: 400 * 24 * time.Hour})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	s.now = func() time.Time { return now }
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func mustRecord(t *testing.T, s *Store, e Event) {
	t.Helper()
	if err := s.Record(e); err != nil {
		t.Fatalf("record: %v", err)
	}
}

var base = time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC) // a Monday

func seed(t *testing.T, s *Store) {
	// 3 hours of traffic, two keys, two models, one failure.
	for h := 0; h < 3; h++ {
		for i := 0; i < 4; i++ {
			ts := base.Add(time.Duration(h)*time.Hour + time.Duration(i)*10*time.Minute)
			e := Event{
				TS: ts.UnixMilli(), ID: ts.Format("150405") + string(rune('a'+i)),
				Key: "aaaaaaaaaaaaaaaa", Provider: "claude", AuthID: "acct-1", Model: "claude-opus",
				Input: 100, Output: 50, CacheRead: 20, Total: 170, LatencyMs: 1200, TTFTMs: 300, Stream: true,
			}
			if i%2 == 1 {
				e.Key, e.Provider, e.AuthID, e.Model = "bbbbbbbbbbbbbbbb", "codex", "acct-2", "gpt-x"
				e.Input, e.Output, e.CacheRead, e.Total, e.LatencyMs = 200, 100, 0, 300, 5000
			}
			if h == 2 && i == 3 {
				e.Failed, e.Status = true, 429
			}
			mustRecord(t, s, e)
		}
	}
}

func TestTimeseriesRollupsMatchEvents(t *testing.T) {
	s := newTestStore(t, base.Add(3*time.Hour))
	seed(t, s)
	from, to := base.UnixMilli(), base.Add(3*time.Hour).UnixMilli()

	hourly, err := s.Timeseries(Query{From: from, To: to, Step: "hour", Group: []string{DimKey}})
	if err != nil {
		t.Fatal(err)
	}
	if hourly.Source != "rollups" {
		t.Fatalf("expected rollups, got %s", hourly.Source)
	}
	minute, err := s.Timeseries(Query{From: from, To: to, Step: "15m", Group: []string{DimKey}})
	if err != nil {
		t.Fatal(err)
	}
	if minute.Source != "events" {
		t.Fatalf("expected events, got %s", minute.Source)
	}
	if hourly.Total != minute.Total {
		t.Fatalf("totals differ:\n%+v\n%+v", hourly.Total, minute.Total)
	}
	if hourly.Total.Requests != 12 || hourly.Total.Failures != 1 || hourly.Total.Total != 6*170+6*300 {
		t.Fatalf("unexpected total %+v", hourly.Total)
	}
	if len(hourly.Series) != 2 || len(hourly.Series[0].Points) != 3 {
		t.Fatalf("unexpected shape: %d series", len(hourly.Series))
	}
	// Sorted by tokens: key b (300/request) first.
	if hourly.Series[0].Group[DimKey] != "bbbbbbbbbbbbbbbb" {
		t.Fatalf("series not sorted by tokens: %v", hourly.Series[0].Group)
	}
	if len(minute.Series[0].Points) != 12 {
		t.Fatalf("expected 12 zero-filled 15m points, got %d", len(minute.Series[0].Points))
	}
}

func TestPartialHourEdgesUseEvents(t *testing.T) {
	s := newTestStore(t, base.Add(3*time.Hour))
	seed(t, s)
	// 00:30 .. 02:20 covers 00:30,00:40? no: events at :00,:10,:20,:30 each hour.
	from := base.Add(30 * time.Minute).UnixMilli()
	to := base.Add(2*time.Hour + 20*time.Minute).UnixMilli()
	res, err := s.Timeseries(Query{From: from, To: to, Step: "hour"})
	if err != nil {
		t.Fatal(err)
	}
	// hour0: :30 (1); hour1: 4; hour2: :00,:10 (2) => 7
	if res.Total.Requests != 7 {
		t.Fatalf("expected 7 requests, got %d", res.Total.Requests)
	}
}

func TestFilterAndTwoDimGroup(t *testing.T) {
	s := newTestStore(t, base.Add(3*time.Hour))
	seed(t, s)
	from, to := base.UnixMilli(), base.Add(3*time.Hour).UnixMilli()
	res, err := s.Timeseries(Query{From: from, To: to, Step: "hour", Group: []string{DimKey, DimModel}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Series) != 2 {
		t.Fatalf("expected 2 key/model series, got %d", len(res.Series))
	}
	filtered, err := s.Timeseries(Query{From: from, To: to, Step: "hour", Group: []string{DimModel},
		Filters: map[string]string{DimAccount: "acct-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if filtered.Total.Requests != 6 || len(filtered.Series) != 1 || filtered.Series[0].Group[DimModel] != "claude-opus" {
		t.Fatalf("unexpected filtered result %+v", filtered.Total)
	}
}

func TestSummaryPreviousAndShares(t *testing.T) {
	s := newTestStore(t, base.Add(3*time.Hour))
	seed(t, s)
	res, err := s.Summary(Query{From: base.Add(2 * time.Hour).UnixMilli(), To: base.Add(3 * time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total.Requests != 4 || res.Previous.Requests != 4 {
		t.Fatalf("unexpected totals %d / %d", res.Total.Requests, res.Previous.Requests)
	}
	models := res.Breakdown[DimModel]
	if len(models) != 2 || models[0].Value != "gpt-x" {
		t.Fatalf("unexpected model breakdown %+v", models)
	}
	sum := models[0].Share + models[1].Share
	if sum < 0.999 || sum > 1.001 {
		t.Fatalf("shares do not add to 1: %f", sum)
	}
}

func TestLabelsWindowsEventsLive(t *testing.T) {
	s := newTestStore(t, base.Add(3*time.Hour))
	seed(t, s)
	if err := s.SetLabel(KeyLabel{Key: "aaaaaaaaaaaaaaaa", Label: "alice"}); err != nil {
		t.Fatal(err)
	}
	w, err := s.Windows(DimKey)
	if err != nil {
		t.Fatal(err)
	}
	if w.Labels["aaaaaaaaaaaaaaaa"] != "alice" || w.Values["aaaaaaaaaaaaaaaa"]["5h"].Requests != 6 {
		t.Fatalf("unexpected windows %+v", w)
	}
	if w.Values["aaaaaaaaaaaaaaaa"]["1h"].Requests != 2 {
		t.Fatalf("expected 2 requests in last hour, got %d", w.Values["aaaaaaaaaaaaaaaa"]["1h"].Requests)
	}
	evs, err := s.Events(EventFilter{Limit: 5, FailedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].Status != 429 {
		t.Fatalf("unexpected failed events %+v", evs)
	}
	all, _ := s.Events(EventFilter{Limit: 3})
	if len(all) != 3 || all[0].TS < all[1].TS || all[0].KeyLabel == "" && all[1].KeyLabel == "" && all[2].KeyLabel == "" {
		t.Fatalf("events not newest-first or unlabeled: %+v", all)
	}
	live, err := s.Live()
	if err != nil {
		t.Fatal(err)
	}
	if len(live.Points) != 60 {
		t.Fatalf("expected 60 live points, got %d", len(live.Points))
	}
}

func TestEmptyStoreQueries(t *testing.T) {
	s := newTestStore(t, base)
	q := Query{From: base.Add(-24 * time.Hour).UnixMilli(), To: base.UnixMilli()}
	if _, err := s.Summary(q); err != nil {
		t.Fatal(err)
	}
	res, err := s.Timeseries(q)
	if err != nil || res.Total.Requests != 0 || res.Series == nil {
		t.Fatalf("empty timeseries: %v %+v", err, res)
	}
	if _, err = s.Windows(DimAccount); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Live(); err != nil {
		t.Fatal(err)
	}
}

func TestPercentileAndBuckets(t *testing.T) {
	var a Agg
	for _, ms := range []int64{100, 200, 300, 900, 1500, 20000} {
		a.addEvent(&Event{LatencyMs: ms})
	}
	if p := a.Percentile(0.5); p != 500 {
		t.Fatalf("p50 = %d", p)
	}
	if p := a.Percentile(0.95); p != 30000 {
		t.Fatalf("p95 = %d", p)
	}
	if m := a.ToMetrics(); m.P95LatencyMs != 20000 || m.P50LatencyMs != 500 {
		t.Fatalf("metrics percentiles not clamped to max: %+v", m)
	}
	// Weeks start on Monday, days honour the timezone offset.
	wed := base.Add(2*24*time.Hour + 5*time.Hour).UnixMilli()
	if got := bucketStart(wed, msWeek, 0); got != base.UnixMilli() {
		t.Fatalf("week bucket = %v", time.UnixMilli(got).UTC())
	}
	// 01:00 UTC is still the previous day at UTC-5.
	if got := bucketStart(base.Add(time.Hour).UnixMilli(), msDay, -300); got != base.Add(-19*time.Hour).UnixMilli() {
		t.Fatalf("tz day bucket = %v", time.UnixMilli(got).UTC())
	}
}

func TestPrune(t *testing.T) {
	s := newTestStore(t, base.Add(40*24*time.Hour))
	seed(t, s)
	events, rollups, err := s.Prune()
	if err != nil {
		t.Fatal(err)
	}
	if events != 12 || rollups != 0 {
		t.Fatalf("pruned %d events, %d rollups", events, rollups)
	}
	// Rollups survive, so long-range hourly queries still work.
	res, err := s.Timeseries(Query{From: base.UnixMilli(), To: base.Add(3 * time.Hour).UnixMilli(), Step: "hour"})
	if err != nil || res.Total.Requests != 12 {
		t.Fatalf("rollups lost after prune: %v %+v", err, res)
	}
}

func TestEventFromRecordNormalisesTokens(t *testing.T) {
	// OpenAI style: input includes cached tokens.
	r := coreusage.Record{
		RequestID: "r1", APIKey: "sk-test", Provider: "Codex", Model: "gpt-x", AuthID: "a",
		RequestedAt: base, Latency: 2 * time.Second,
		Detail: coreusage.Detail{TokenBreakdown: coreusage.NewSubsetTokenBreakdown(1000, 400, 0, 300, 100, 1300)},
	}
	e := EventFromRecord(r)
	if e.Input != 600 || e.CacheRead != 400 || e.Output != 300 || e.Reasoning != 100 || e.Total != 1300 {
		t.Fatalf("subset normalisation wrong: %+v", e)
	}
	if e.Key != Fingerprint("sk-test") || len(e.Key) != 16 || e.Provider != "codex" || e.LatencyMs != 2000 {
		t.Fatalf("metadata wrong: %+v", e)
	}
	// Anthropic style: cache counted separately from input.
	r.Detail = coreusage.Detail{TokenBreakdown: coreusage.NewIndependentTokenBreakdown(50, 900, 100, 200, 0, 1250)}
	e = EventFromRecord(r)
	if e.Input != 50 || e.CacheRead != 900 || e.CacheCreation != 100 || e.Output != 200 || e.Total != 1250 {
		t.Fatalf("independent normalisation wrong: %+v", e)
	}
}

func TestRecordBatchMatchesSingleWrites(t *testing.T) {
	a := newTestStore(t, base.Add(3*time.Hour))
	seed(t, a)
	var events []Event
	_ = a.scanEvents(0, base.Add(10*time.Hour).UnixMilli(), func(e *Event) bool {
		events = append(events, *e)
		return true
	})
	b := newTestStore(t, base.Add(3*time.Hour))
	// Split across two batches that share rollup rows.
	if err := b.RecordBatch(events[:5]); err != nil {
		t.Fatal(err)
	}
	if err := b.RecordBatch(events[5:]); err != nil {
		t.Fatal(err)
	}
	q := Query{From: base.UnixMilli(), To: base.Add(3 * time.Hour).UnixMilli(), Step: "hour", Group: []string{DimKey, DimModel}}
	ra, _ := a.Timeseries(q)
	rb, _ := b.Timeseries(q)
	if ra.Total != rb.Total || len(ra.Series) != len(rb.Series) {
		t.Fatalf("batch differs:\n%+v\n%+v", ra.Total, rb.Total)
	}
	for i := range ra.Series {
		if ra.Series[i].Total != rb.Series[i].Total {
			t.Fatalf("series %d differs", i)
		}
	}
}
