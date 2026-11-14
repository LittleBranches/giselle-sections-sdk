type Issue = { path: readonly PropertyKey[]; message: string };

/** One line per validation issue, as `path: message`; `label` names the value when the issue has no path. */
export const issuesOf = (error: { issues: readonly Issue[] }, label = 'content'): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.') || `(${label})`}: ${issue.message}`);
