-- AutoRange (reCLAMM) daily raw state for one Ethereum pool — parameterized by {{pool}}
-- Output: per-day reserves(scaled), BPT supply(scaled), USD prices, TVL.
-- HODL leg + window indexing are computed client-side from this raw state.
--
-- v3 changes vs v2:
--   * Calendar-day spine with forward-filled reserves/supply — one row per day
--     from the pool's first event to today, not just days with events. Quiet
--     days previously vanished, which distorted window slicing and skipped
--     price moves in the HODL marking.
--   * prices.day instead of aggregating prices.usd minutes — ~365 rows/token
--     scanned instead of ~500k, much faster and cheaper.
WITH meta AS (
  SELECT
    from_hex(json_extract_scalar(tokenconfig[1], '$.token')) AS token0,
    from_hex(json_extract_scalar(tokenconfig[2], '$.token')) AS token1,
    date_trunc('day', evt_block_time) AS reg_day
  FROM balancer_v3_ethereum.vault_evt_poolregistered
  WHERE pool = {{pool}}
  LIMIT 1
),
info AS (
  SELECT m.token0, m.token1,
         t0.decimals dec0, t1.decimals dec1,
         t0.symbol sym0, t1.symbol sym1
  FROM meta m
  LEFT JOIN tokens.erc20 t0 ON t0.blockchain='ethereum' AND t0.contract_address = m.token0
  LEFT JOIN tokens.erc20 t1 ON t1.blockchain='ethereum' AND t1.contract_address = m.token1
),
ev AS (
  SELECT evt_block_time t, evt_index,
         CAST(amountsaddedraw[1] AS double) d0, CAST(amountsaddedraw[2] AS double) d1,
         CAST(totalsupply AS double) supply
  FROM balancer_v3_ethereum.vault_evt_liquidityadded
  WHERE pool = {{pool}}
  UNION ALL
  SELECT evt_block_time, evt_index,
         -CAST(amountsremovedraw[1] AS double), -CAST(amountsremovedraw[2] AS double),
         CAST(totalsupply AS double)
  FROM balancer_v3_ethereum.vault_evt_liquidityremoved
  WHERE pool = {{pool}}
  UNION ALL
  SELECT s.evt_block_time, s.evt_index,
         CASE WHEN s.tokenin = i.token0 THEN  CAST(s.amountin AS double)
              WHEN s.tokenout = i.token0 THEN -CAST(s.amountout AS double) ELSE 0 END,
         CASE WHEN s.tokenin = i.token1 THEN  CAST(s.amountin AS double)
              WHEN s.tokenout = i.token1 THEN -CAST(s.amountout AS double) ELSE 0 END,
         CAST(NULL AS double)
  FROM balancer_v3_ethereum.vault_evt_swap s CROSS JOIN info i
  WHERE s.pool = {{pool}}
),
run AS (
  SELECT t, evt_index,
         SUM(d0) OVER (ORDER BY t, evt_index ROWS UNBOUNDED PRECEDING) bal0,
         SUM(d1) OVER (ORDER BY t, evt_index ROWS UNBOUNDED PRECEDING) bal1,
         last_value(supply) IGNORE NULLS OVER (ORDER BY t, evt_index ROWS UNBOUNDED PRECEDING) supply
  FROM ev
),
eod AS (
  SELECT date_trunc('day', t) d, bal0, bal1, supply,
         row_number() OVER (PARTITION BY date_trunc('day', t) ORDER BY t DESC, evt_index DESC) rn
  FROM run
),
state AS (SELECT d, bal0, bal1, supply FROM eod WHERE rn = 1),
spine AS (
  SELECT u.d
  FROM (SELECT sequence(CAST(min(d) AS date), current_date, INTERVAL '1' DAY) ds FROM state) s
  CROSS JOIN UNNEST(s.ds) AS u(d)
),
filled AS (
  SELECT CAST(sp.d AS timestamp) d,
         last_value(st.bal0)   IGNORE NULLS OVER (ORDER BY sp.d ROWS UNBOUNDED PRECEDING) bal0,
         last_value(st.bal1)   IGNORE NULLS OVER (ORDER BY sp.d ROWS UNBOUNDED PRECEDING) bal1,
         last_value(st.supply) IGNORE NULLS OVER (ORDER BY sp.d ROWS UNBOUNDED PRECEDING) supply
  FROM spine sp
  LEFT JOIN state st ON st.d = CAST(sp.d AS timestamp)
),
px AS (
  -- Constant lower bound enables partition pruning (no reCLAMM predates it);
  -- the dynamic reg_day bound narrows further but can't prune on its own.
  SELECT date_trunc('day', p.timestamp) d, p.contract_address, p.price
  FROM prices.day p
  WHERE p.blockchain = 'ethereum'
    AND p.timestamp >= TIMESTAMP '2025-06-01'
    AND p.contract_address IN (SELECT token0 FROM meta UNION ALL SELECT token1 FROM meta)
    AND p.timestamp >= (SELECT reg_day FROM meta)
)
SELECT
  f.d AS day,
  i.sym0, i.sym1,
  f.bal0 / pow(10, i.dec0) AS res0,
  f.bal1 / pow(10, i.dec1) AS res1,
  f.supply / 1e18 AS bpt,
  p0.price AS price0,
  p1.price AS price1,
  (f.bal0 / pow(10, i.dec0)) * p0.price + (f.bal1 / pow(10, i.dec1)) * p1.price AS tvl_usd
FROM filled f
CROSS JOIN info i
JOIN px p0 ON p0.d = f.d AND p0.contract_address = i.token0
JOIN px p1 ON p1.d = f.d AND p1.contract_address = i.token1
WHERE f.supply > 0
ORDER BY day
