-- ============================================================================
-- Loom — remove the test data. Nothing else is touched: applications go with
-- their cards through the FK cascade, and the six real cv- cards are matched
-- by neither condition.
-- ============================================================================
delete from knowledge_items where origin = 'test' or id like 'test-%';

-- check: select count(*) from knowledge_items;  -- back to the real count (6)
