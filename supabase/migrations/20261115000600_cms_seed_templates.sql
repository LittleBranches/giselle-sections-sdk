-- The built-in section templates, upserted (so the file can be applied again). A site registers types under the keys these
-- name (`section`, `banner`, `card`, `timeline`) to use them, or seeds templates of its own beside them. These rows equal the
-- SDK's `BUILTIN_SECTION_TEMPLATES`; a test compares the two.

insert into cms_templates (key, name, container_type_key, slots, built_in) values
  ('banner-section', 'Banner section', 'section',
   '[{"key": "banner", "label": "Banner", "allowedTypeKeys": ["banner"], "min": 1, "max": 1}]'::jsonb, true),
  ('help-section', 'Help section with cards', 'section',
   '[{"key": "cards", "label": "Cards", "allowedTypeKeys": ["card"], "min": 0, "max": 24}]'::jsonb, true),
  ('timeline-section', 'Timeline section', 'section',
   '[{"key": "timeline", "label": "Timeline", "allowedTypeKeys": ["timeline"], "min": 1, "max": 1}]'::jsonb, true)
on conflict (key) do update
  set name = excluded.name,
      container_type_key = excluded.container_type_key,
      slots = excluded.slots,
      built_in = true;
