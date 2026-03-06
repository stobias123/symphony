.PHONY: help rebuild

MISE ?= mise
ELIXIR_DIR := elixir

help:
	@echo "Targets: rebuild"

rebuild:
	cd $(ELIXIR_DIR) && $(MISE) exec -- mix build
