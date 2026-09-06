-- Storage RLS for the private `pdfs` bucket.
--
-- Object keys are laid out as `<user_id>/<document_id>.pdf`, so the first path
-- segment is the ownership claim. A caller may only touch objects whose first
-- segment equals their own JWT `sub`, and only inside this one bucket.
--
-- Fresh InsForge installs ship with RLS disabled on storage.objects, which
-- means table grants alone would let any authenticated user read every row.
-- The ENABLE statement is idempotent, so it always belongs here.

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storage_objects_owner_select ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;

CREATE POLICY pdfs_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket = 'pdfs'
    AND (storage.foldername(key))[1] = (SELECT auth.jwt() ->> 'sub')
  );

CREATE POLICY pdfs_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket = 'pdfs'
    AND uploaded_by = (SELECT auth.jwt() ->> 'sub')
    AND (storage.foldername(key))[1] = (SELECT auth.jwt() ->> 'sub')
  );

CREATE POLICY pdfs_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket = 'pdfs'
    AND (storage.foldername(key))[1] = (SELECT auth.jwt() ->> 'sub')
  )
  WITH CHECK (
    bucket = 'pdfs'
    AND (storage.foldername(key))[1] = (SELECT auth.jwt() ->> 'sub')
  );

CREATE POLICY pdfs_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket = 'pdfs'
    AND (storage.foldername(key))[1] = (SELECT auth.jwt() ->> 'sub')
  );

GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;

-- Anonymous callers get nothing: no policies above name `anon`, and no grants.
