#### v0.0.2
- Fixed a socket leak that was caused by incorrectly splicing an array. It
  removed the first item from the pool instead of item that was found using
  indexOf. See #2

#### v0.0.1
- Small fix for the isAvailable method, returns a larger availablity. See #1

#### v0.0.0
- Inital release
