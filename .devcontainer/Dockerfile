# YouGrow dev container: Node 24, Java 21 for the Firebase emulators, the Google Cloud CLI and
# the Firebase CLI. `npm run local` needs no sign-in. Only the self-host steps
# (docs/self-host.md) do, and in a container there is no local browser, so sign in with:
#   gcloud auth login --no-launch-browser
#   gcloud auth application-default login --no-launch-browser
#   firebase login --no-localhost
FROM node:24-bookworm-slim

# Java 21 from the official Temurin image (the emulators need only the runtime).
ENV JAVA_HOME=/opt/java/openjdk
COPY --from=eclipse-temurin:21-jre $JAVA_HOME $JAVA_HOME
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# The Google Cloud CLI from Google's apt repository, plus git and curl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && CLOUDSDK_SKIP_PY_COMPILATION=1 apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# The Firebase CLI version npm run local pins (PINNED_FIREBASE_TOOLS in scripts/lib/local-env.mjs).
RUN npm install -g firebase-tools@15.27.0 && npm cache clean --force

USER node
