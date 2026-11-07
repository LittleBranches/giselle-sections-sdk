---
'@littlebranches/giselle-sections-sdk': minor
---

Rename the checklist items of a timeline phase from steps to tasks, to match the component library's own wording: `steps` becomes `tasks`, `TimelineStepDto` becomes `TimelineTaskDto`, and `createStableStepKey` becomes `createStableTaskKey`. "Step" was already taken by stepper steps in the apps. Breaking: update imports and the `steps` field.
