---
'@littlebranches/giselle-sections-sdk': minor
---

Add the timeline provider's first write method: `WritableTimelineDataProvider` (a `TimelineDataProvider` that can also `updateTimelinePhaseTitle`), with `parseTimelinePhaseTitle` to validate a title on the way in and `TimelineValidationError` for a rejected value.
