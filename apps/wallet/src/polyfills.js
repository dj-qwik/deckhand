// Must be imported before anything from Privy: its silent signing path expects a
// global Buffer (symptom without it: "Buffer is not defined" / "An unknown RPC error occurred").
import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
  window.Buffer = window.Buffer || Buffer;
  window.global = window.global || window;
  window.process = window.process || { env: {} };
}
