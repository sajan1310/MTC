# Fix Production Lot Detail Page
## Goal Description
Update the frontend JavaScript and HTML to correctly use variant option data, ensure the add‑variant workflow works, and synchronize UI elements (subprocess select, variant select, alerts, finalize button). Also adjust any missing HTML IDs/classes.

## Proposed Changes
- **production_lot_detail.js**
  - Refactor `renderSubprocesses` and `populateSubprocessSelect` to read from `this._variantOptions.subprocesses` instead of `this.lotData.subprocesses`.
  - Update `submitAddVariantForm` to build a payload containing `subprocess_id`, `variant_id`, `quantity`, and optional `substitute_group_id` and send it to the correct endpoint `/api/upf/production-lots/${this.lotId}/variant-options` (POST). After success, refresh variant options via `fetchVariantOptions()` and re‑render UI.
  - Implement `populateAddVariantForm` to fill the substitute‑group and variant dropdowns based on the currently selected subprocess data from `_variantOptions`.
  - Ensure `fetchVariantOptions` stores the full response (`data?.data || data || {}`) in `_variantOptions`.
  - Add missing UI updates: after adding a variant, call `this.renderSubprocesses()` and `this.populateSubprocessSelect()`.
  - Verify `updateFinalizeButton` disables the finalize button when critical alerts exist.
- **upf_production_lot_detail.html**
  - Confirm IDs used in JS (`subprocess-select-for-add`, `variant-group-select`, `variant-select`, `add-variant-form`, etc.) exist and are unique.
  - Add `data-process-subprocess-id` attributes to variant group/variant selects where needed.

## Verification Plan
### Automated
1. **Run the Flask development server**
   ```
   cd C:/Users/erkar/OneDrive/Desktop/MTC/Project-root
   python run.py
   ```
2. **Execute a simple integration script** (Python) that:
   - Calls the API `/api/upf/production-lots/<id>/variant-options` to ensure JSON structure contains `subprocesses`.
   - Posts a new variant selection to `/api/upf/production-lots/<id>/variant-options` and checks for a successful response.
3. **Run existing unit tests** (if any) with:
   ```
   pytest
   ```
   Verify no failures.
### Manual
1. Open the page `http://127.0.0.1:5000/upf/production-lot/<lot_id>` in a browser.
2. Verify that the **Subprocesses** section lists subprocesses (populated from variant options).
3. Click **+ Add Variant**, select a subprocess, then a variant (or group), set quantity, and press **Save Variant**.
4. Confirm the variant appears in the **Selected Variants** panel and that the subprocess list refreshes.
5. Check that the **Critical Alert Banner** appears only when there are unacknowledged critical alerts and that the **Finalize** button is disabled in that case.
6. Acknowledge all critical alerts, ensure the banner disappears and the **Finalize** button becomes enabled.
7. Click **Finalize**, confirm success toast, and verify the lot status updates.

**How to run manual test:**
- Use Chrome/Firefox, open dev console, watch for any JavaScript errors.
- Interact with the UI as described above.
- Observe toast notifications and UI state changes.

## Risks & Assumptions
- Assumes backend endpoint `/api/upf/production-lots/<id>/variant-options` accepts POST payload as described.
- Assumes HTML template contains the IDs referenced; otherwise they will be added.
- No existing automated tests for this page, so manual verification is essential.
