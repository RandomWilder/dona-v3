-- occupancy: what one pass over a document found out about the document
-- itself. Described in SPEC-occupancy.md, "An incomplete lease says so".
--
-- The first cut of slice 12.1 returned these three facts from ingestDocument
-- and stored none of them, so the browser redirect dropped them and no screen
-- could ever show them again. A property that exists for the length of one HTTP
-- response is not a property the system has.

ALTER TABLE occupancy_documents
  -- NULL means never read, and it is the honest answer to "has this been
  -- ingested" -- which a chunk count is not. A document read that produced zero
  -- chunks and a document nobody has read look identical from a count.
  ADD COLUMN IF NOT EXISTS ingested_at timestamptz,
  ADD COLUMN IF NOT EXISTS page_count integer,
  -- The pages that carried no text layer, named rather than counted. OCR is
  -- week 3's cut line (ROADMAP.md): a lease four pages short must say which
  -- four, so a later slice -- or a person -- can fill them.
  ADD COLUMN IF NOT EXISTS image_only_pages integer[];
