-- Retired experiment preferences only; preserve all other settings and chat text.
UPDATE users
SET settings = json_remove(settings, '$.canvasAnswers', '$.showThoughtSignatures')
WHERE CASE WHEN json_valid(settings) THEN
  json_type(settings) = 'object' AND
  (json_type(settings, '$.canvasAnswers') IS NOT NULL OR
   json_type(settings, '$.showThoughtSignatures') IS NOT NULL)
ELSE 0 END;
