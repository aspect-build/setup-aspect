# Third-party notices

This action is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
It includes portions of code adapted from third-party projects, listed below
with their respective licenses.

---

## bazel-contrib/setup-bazel

Files [`index.js`](index.js), [`post.js`](post.js), [`config.js`](config.js),
and [`util.js`](util.js) are adapted from
[bazel-contrib/setup-bazel](https://github.com/bazel-contrib/setup-bazel),
with Aspect-specific changes (launcher install, Aspect-prefixed cache keys,
Workflows-runner branch, JWT-persist via `aspect auth login`, removal of
Windows code paths and Google credentials passthrough).

```
MIT License

Copyright (c) 2023 Alex Rodionov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
