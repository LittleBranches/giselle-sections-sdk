---
'@littlebranches/giselle-sections-sdk': minor
---

Grow `WritableTimelineDataProvider` from one write to the whole plan: `updateTimelinePhase` (title, short title, description, date), `addTimelinePhase`, `removeTimelinePhase`, `reorderTimelinePhases`, `addTimelineTask`, `updateTimelineTaskTitle`, `removeTimelineTask` and `reorderTimelineTasks`. Ids are the backend's: a removed id is never handed out again, and order is independent of identity. Adds `parseTimelinePhaseFields`, `parseTimelineTaskTitle` and `parseTimelineOrder` so every backend validates the same way, with the length limits exported as constants. A backend that implemented the old interface must add the new methods.
