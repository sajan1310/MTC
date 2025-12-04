# Task Checklist for Production Lot Detail Page Fixes
- [ ] Update `renderSubprocesses` and `populateSubprocessSelect` to use `this._variantOptions.subprocesses`.
- [ ] Refactor `submitAddVariantForm` to construct correct payload and call appropriate API endpoint.
- [ ] Ensure `populateAddVariantForm` populates variant groups and variants based on fetched variant options.
- [ ] Verify `fetchVariantOptions` correctly loads variant data and stores in `_variantOptions`.
- [ ] Add any missing UI updates (e.g., refresh variant options after adding).
- [ ] Validate HTML template IDs and classes match JS expectations.
- [ ] Run linting and basic sanity checks.
- [ ] Document changes in implementation plan.
