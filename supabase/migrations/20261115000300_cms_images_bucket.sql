-- The bucket for the images of the public pages, and the rules on it. This file holds no image of any one site, and it can be
-- applied to any database, again and again: the bucket is upserted and each policy is dropped before it is created.
--
-- Who may do what (the helpers are the standard ones from the roles file):
--   anyone, no sign-in   see and fetch the images (they are public content)
--   editors and owners   add an image
--   everyone, editors and owners too   change or delete an image: nobody can, through the app
--
-- Nothing deletes a file. Removing an image from a list only takes it off the list, and a content version that was saved
-- with it keeps pointing at it, so restoring that version still shows the picture. Cleaning up files nobody points at any
-- more is a separate job, done by the owner with the database's own tools. Because a file is never replaced, each upload
-- must use a new name (the app puts a fresh id in every name).
--
-- The bucket itself also refuses what is not an image: JPEG, PNG and WebP only, 5 MB at most.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-images', 'site-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- (Each policy is dropped first if it is there, so the file can be applied again, for instance after the bucket was made by hand.)
--
-- Read: anyone. (A public bucket serves its files by address without these rules; this one lets the app list them.)
drop policy if exists "site images can be read by anyone" on storage.objects;
create policy "site images can be read by anyone"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'site-images');

-- Add: editors and owners only, and only into this bucket.
drop policy if exists "editors and owners can add site images" on storage.objects;
create policy "editors and owners can add site images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'site-images' and public.can_edit());

-- No policy for update or delete: with row-level security on, that means nobody may.
