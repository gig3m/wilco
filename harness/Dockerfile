# The board's browser, pinned to the Playwright the checks were written
# against. The harness is stdlib + playwright; nothing else to pip install.
#
# The base image bundles the browser binaries (/ms-playwright) and their OS
# deps, but NOT the `playwright` pip package itself -- `import playwright`
# fails on the bare base image. Pinning the same version as the base image
# avoids Playwright re-downloading browsers that are already present.
FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy
WORKDIR /h
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir playwright==1.49.0
