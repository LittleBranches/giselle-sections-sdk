---
'@littlebranches/giselle-sections-sdk': minor
---

Identify a timeline phase's checklist tasks by a stable id instead of their position. `TimelineTaskDto` gains a required `id` (string or number, unique among all tasks, never reused by the consumer), and `createStableTaskKey` now takes that id alone: `createStableTaskKey(taskId)`. Mapped `children` are keyed by it, so a consumer can add, remove and reorder tasks without losing the ticks it recorded. Breaking: pass an `id` on every task and update any call to `createStableTaskKey`.
