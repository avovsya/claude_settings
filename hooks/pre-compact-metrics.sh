#!/bin/bash
# Log compaction events for fits_in_one_context calibration
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"cwd\":\"$(pwd)\",\"source\":\"${1:-unknown}\"}" >> ~/.claude/compaction-metrics.jsonl
