import ctypes
from ctypes import c_char_p, POINTER, c_float, byref

libc = ctypes.cdll.msvcrt
buf = b'"depth":0.3,"duration":2.0'
p1 = c_float()

# format: "depth"%*[^0-9.]%f
fmt = b'"depth"%*[^0-9.]%f'
res = libc.sscanf(buf, fmt, byref(p1))
print(f"res={res}, p1={p1.value}")
