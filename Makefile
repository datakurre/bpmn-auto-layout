.PHONY: shell feedback-ui feedback-selftest feedback-report feedback-check

shell:
	nix develop

# Start the browser review UI without building the layout package.
feedback-ui:
	nix run .#bpmn-feedback-ui

# --- Targets below assume they run inside the dev shell ---
# From outside the shell, prefix with nix-: make nix-feedback-check

feedback-selftest:
	bpmn-feedback selftest

feedback-report:
	bpmn-feedback report fixtures/*.bpmn

feedback-check: feedback-report
	bpmn-feedback check

# Run any target inside the dev shell: make nix-feedback-check
nix-%:
	nix develop --command $(MAKE) $*

# The UI does not need the layout package or the full development shell.
nix-feedback-ui:
	nix run .#bpmn-feedback-ui
