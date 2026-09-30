use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Error codes are part of the wire contract; see PROTOCOL.md §4.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    NotFound,
    Conflict,
    PayloadTooLarge,
    /// Part of the wire contract; no limiter is wired up yet.
    #[allow(dead_code, reason = "reserved for the per-token rate limiter")]
    RateLimited,
    Internal,
}

impl ErrorCode {
    fn status(self) -> StatusCode {
        match self {
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, msg)
    }

    pub fn unauthorized() -> Self {
        Self::new(ErrorCode::Unauthorized, "missing or invalid bearer token")
    }

    pub fn not_found() -> Self {
        Self::new(ErrorCode::NotFound, "not found")
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, msg)
    }
}

/// Internal failures are logged in full but reported opaquely: the client can
/// do nothing with a filesystem path, and it should not learn one.
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        tracing::error!(error = %e, "io error");
        Self::new(ErrorCode::Internal, "internal error")
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "internal error");
        Self::new(ErrorCode::Internal, "internal error")
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        tracing::error!(error = %e, "json error");
        Self::new(ErrorCode::Internal, "internal error")
    }
}

#[derive(Serialize)]
struct Body {
    error: Inner,
}

#[derive(Serialize)]
struct Inner {
    code: ErrorCode,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.code.status();
        let body = Body { error: Inner { code: self.code, message: self.message } };
        (status, axum::Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
