# Build
FROM rust:1.98-slim-bookworm AS build
WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
COPY cli/Cargo.toml cli/Cargo.toml
COPY server/src server/src
COPY cli/src cli/src
COPY protocol protocol

RUN cargo build --release --package obsydian-sync-server

# Run
#
# Not `scratch`: the server shells out to git to commit its data directory, so
# git has to be present. Slim plus git is still a small image, and it keeps the
# history feature rather than trading it for a few megabytes.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Runs as an ordinary user. The compose file maps this to the host's 1000:1000,
# matching the rest of the stack's appdata ownership.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin obsydian
USER obsydian

COPY --from=build /src/target/release/obsydian-sync-server /usr/local/bin/

VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/obsydian-sync-server"]
CMD ["/config/config.toml"]
