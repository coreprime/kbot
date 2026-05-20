package studio

import (
	"container/heap"
	"sync"

	"golang.org/x/sync/singleflight"
)

// Asset queue ─ a priority-based worker pool for cache-warming work.
//
// Two callers feed it:
//
//   1. startAssetPreload, on server boot, enqueues every section /
//      feature thumbnail at PriorityLow.  Workers chew through the
//      list while the editor is starting up.
//
//   2. Live HTTP handlers (section-preview / feature-preview /
//      section-image) call Run with PriorityHigh when the user asks
//      for a specific asset that hasn't been warmed yet.  The job
//      jumps the queue and blocks the request until it finishes.
//
// singleflight.Group dedupes concurrent Run calls for the same key so
// the disk read + render happens once even when several browser
// requests pile up at the same moment.
//
// Cache hit/miss is owned by the caller's `run` closure; the queue is
// just a scheduler.  Jobs that fire after their target has already
// been cached (e.g. a low-priority preload job whose key was satisfied
// earlier by a HIGH job) are expected to no-op via their own cache
// check.

const (
	priorityLow  = 0
	priorityHigh = 100
)

type assetJob struct {
	priority int
	seq      int64 // FIFO tiebreaker within the same priority
	run      func()
	done     chan struct{}
}

type assetPQ []*assetJob

func (pq assetPQ) Len() int { return len(pq) }
func (pq assetPQ) Less(i, j int) bool {
	if pq[i].priority != pq[j].priority {
		return pq[i].priority > pq[j].priority
	}
	return pq[i].seq < pq[j].seq
}
func (pq assetPQ) Swap(i, j int) { pq[i], pq[j] = pq[j], pq[i] }
func (pq *assetPQ) Push(x any)   { *pq = append(*pq, x.(*assetJob)) }
func (pq *assetPQ) Pop() any {
	old := *pq
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*pq = old[:n-1]
	return item
}

// AssetQueue is a heap-backed priority queue serviced by a fixed pool
// of worker goroutines.  Submit / Run are safe for concurrent use.
type AssetQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	pq     assetPQ
	seq    int64
	closed bool
	sf     singleflight.Group
}

func newAssetQueue(workers int) *AssetQueue {
	q := &AssetQueue{}
	q.cond = sync.NewCond(&q.mu)
	for i := 0; i < workers; i++ {
		go q.workerLoop()
	}
	return q
}

// Submit enqueues a fire-and-forget job at the given priority.  The
// caller doesn't wait for completion — workers eventually pick it up
// in priority order.
func (q *AssetQueue) Submit(priority int, run func()) {
	if run == nil {
		return
	}
	q.mu.Lock()
	q.seq++
	heap.Push(&q.pq, &assetJob{priority: priority, seq: q.seq, run: run})
	q.cond.Signal()
	q.mu.Unlock()
}

// Run enqueues a HIGH-priority job and blocks until it finishes.
// Concurrent Run calls for the same key share one execution via
// singleflight, so a stampede of browser tabs asking for the same
// section preview only renders once.
//
// Live HTTP handlers call this — the queue jumps a job ahead of any
// pending preload work, the singleflight dedupes against any other
// in-flight request, and the caller resumes once the cache has been
// populated.
func (q *AssetQueue) Run(key string, run func()) {
	if run == nil {
		return
	}
	_, _, _ = q.sf.Do(key, func() (any, error) {
		done := make(chan struct{})
		q.mu.Lock()
		q.seq++
		heap.Push(&q.pq, &assetJob{
			priority: priorityHigh,
			seq:      q.seq,
			run:      run,
			done:     done,
		})
		q.cond.Signal()
		q.mu.Unlock()
		<-done
		return nil, nil
	})
}

func (q *AssetQueue) workerLoop() {
	for {
		q.mu.Lock()
		for len(q.pq) == 0 && !q.closed {
			q.cond.Wait()
		}
		if q.closed && len(q.pq) == 0 {
			q.mu.Unlock()
			return
		}
		job := heap.Pop(&q.pq).(*assetJob)
		q.mu.Unlock()
		// Run outside the lock so other workers stay free to pick the
		// next job — and so a slow render can't stall HIGH-priority
		// submissions waiting to be queued.
		func() {
			defer func() {
				if job.done != nil {
					close(job.done)
				}
			}()
			job.run()
		}()
	}
}

// ── The package-level queue instance ─────────────────────────────────
//
// startAssetPreload + the live handlers both call into this one queue
// so HIGH-priority handler work can preempt LOW-priority preload work.
// Initialised lazily on first use so tests that don't need the queue
// don't pay for the workers.

var (
	assetQueueOnce sync.Once
	assetQueue     *AssetQueue
)

func getAssetQueue() *AssetQueue {
	assetQueueOnce.Do(func() {
		assetQueue = newAssetQueue(assetQueueWorkers())
	})
	return assetQueue
}

// assetQueueWorkers picks the worker pool size.  The asset pipeline is
// disk-bound (HPI extract + image decode), so a few workers in
// parallel saturate the SSD without thrashing.  We deliberately keep
// it bounded to avoid memory spikes when warming thousands of
// features at once.
func assetQueueWorkers() int {
	return 4
}
