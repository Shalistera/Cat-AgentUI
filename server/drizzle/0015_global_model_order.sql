-- Model ordering becomes one global sequence across providers (the picker no
-- longer groups by provider). Flatten the old two-level order — provider rank,
-- then rank within the provider — into contiguous global sort_order values so
-- nothing visibly moves on upgrade.
UPDATE models SET sort_order = (
  SELECT rn FROM (
    SELECT m.id AS mid,
           ROW_NUMBER() OVER (
             ORDER BY p.sort_order, p.created_at, m.sort_order, m.model_id
           ) - 1 AS rn
    FROM models m
    JOIN providers p ON p.id = m.provider_id
  ) WHERE mid = models.id
);
