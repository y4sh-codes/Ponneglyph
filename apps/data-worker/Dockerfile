FROM rust:1-bookworm AS builder

RUN apt-get update && apt-get install -y musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl || true
RUN rm -rf src

COPY src/ src/
RUN touch src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl

FROM public.ecr.aws/lambda/provided:al2023

COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/data-worker ${LAMBDA_RUNTIME_DIR}/bootstrap

CMD ["bootstrap"]
