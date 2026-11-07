# Changesets

Every change that should reach consumers adds a changeset (`npx changeset`): a small Markdown file saying which
package changes and by how much. A canary release is published from `main` under the `canary` tag; it never touches
the real version number or the changelog.
