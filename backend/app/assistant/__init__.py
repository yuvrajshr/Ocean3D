"""The ocean assistant: a Gemini-backed copilot that answers from real data.

Two rules govern everything in this package, and both come from context.md §5.1:

1. **Every number the assistant states must come from a tool call.** It may
   explain oceanography from its own knowledge, but it may not state a
   *measurement* it did not fetch. This is enforced structurally — the panel
   renders its provenance line from the tool calls that actually ran, so an
   ungrounded number has nothing to cite and is visibly marked as general
   knowledge rather than quietly passing as data.

2. **Only `gemini_client.py` talks to Gemini**, exactly as `erddap_client.py`
   is the only place that talks to an upstream. The API key is server-side and
   never reaches the browser, same as the Copernicus credentials (§5.5).
"""
