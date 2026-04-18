from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = Field(default="development")
    debug: bool = Field(default=False)

    database_url: str = Field(default="postgresql+asyncpg://pulse:pulse@localhost:5432/pulse")
    redis_url: str = Field(default="redis://localhost:6379/0")

    secret_key: str = Field(default="change-me-in-production")
    access_token_expire_minutes: int = Field(default=60)
    jwt_algorithm: str = Field(default="HS256")

    temporal_host: str = Field(default="localhost:7233")
    temporal_namespace: str = Field(default="default")

    s3_endpoint_url: str | None = Field(default=None)
    s3_bucket: str = Field(default="pulse-artifacts")
    aws_region: str = Field(default="us-east-1")

    anthropic_api_key: str = Field(default="")
    feature_llm_enabled: bool = Field(default=True)

    sentry_dsn: str | None = Field(default=None)
    log_level: str = Field(default="INFO")


@lru_cache
def get_settings() -> Settings:
    return Settings()
