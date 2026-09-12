"""Ocean assistant (Gemini).

- Any number it gives has to come from a tool call. The panel builds the
  citation line from the calls that actually ran, so an unsourced answer is
  marked as general knowledge.
- Only gemini_client.py talks to Gemini, and the key never leaves the server.
"""
