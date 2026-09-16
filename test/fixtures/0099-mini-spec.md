# Tech spec 0099 — Mini fixture

| | |
| --- | --- |
| **Status** | Draft |
| **Source PRD** | specs/0099-mini.md |
| **Created** | 2026-09-02 |
| **Updated** | 2026-09-15 |
| **Open ADRs** | — |

## 1. Source PRD Summary

| FR | AC(s) | Restatement |
| --- | --- | --- |
| FR-1 | AC-1 | Show a delivery date picker in checkout |
| FR-2 | AC-2 | Restrict the picker to working days |

## 2. Architectural Decisions

| Decision | Extension point | Data model & migrations | Trade-offs | Verified by |
| --- | --- | --- | --- | --- |
| Custom field on the order | `OrderDefinition` custom fields | one migration | limited filtering | vendor/shopware/core/Checkout/Order/OrderDefinition.php:88 |

Diagram: specs/0099-mini-spec.architecture.excalidraw

**Verified assumptions:** custom fields on the order are writable through the Store API
**Unverified / at risk:** none

## 3. Per-AC Implementation Plan

**Parallel groups:** Group 1 (parallel): AC-1, AC-2

- **AC-1** [partly] (FR-1)
  - **Depends on:** none
  - **Decision:** [done] custom field `delivery_date` on the order, see §2 row 1
  - **Implementation plan (TDD order):** failing Store API test, then the migration, then the twig block
  - **Tests:** `DeliveryDateFieldTest::testFieldIsWritable`
- **AC-2** (FR-2, FR-3)
  - **Depends on:** AC-1
  - **Decision:** _TBD_
  - **Implementation plan (TDD order):** failing unit test for the working-day filter
  - **Tests:** `WorkingDayFilterTest::testSkipsWeekends`

## 6. Open Questions

| # | Question | Impact | Blocks | Options | Agent notes |
| --- | --- | --- | --- | --- | --- |
| Q-1 | [adr] Which calendar defines the non-working days? | high | FR-2, AC-2 | A: Shipping country of the order (recommended)<br>B: Shop default country<br>C: Merchant-maintained list | [pm] Recommends A: matches how tax is already resolved<br>[architect] C: needs an admin module nobody scoped |
| Q-2 | Should the date appear on the invoice? | low | FR-3 | | |

## 7. Readiness

| # | Criterion | Met |
| --- | --- | --- |
| C-1 | Every AC has an implementation plan | yes |
| C-2 | Every AC has a test | yes |
