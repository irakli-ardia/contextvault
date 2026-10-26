-- The workspace bootstrap policies treat `created_at = now()` as "created in this transaction".
-- INSERT is granted on created_at (Drizzle names every column), so the value must be overwritten
-- server-side or a caller could choose it.
CREATE FUNCTION "workspaces_set_created_at"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "workspaces_set_created_at" BEFORE INSERT ON "workspaces"
  FOR EACH ROW EXECUTE FUNCTION "workspaces_set_created_at"();
