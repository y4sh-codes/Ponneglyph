// For testing only... saswata remove this shit

"use client";

import { useState } from "react";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

export default function TestUploadPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [publisher, setPublisher] = useState("");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  }

  function handleThumbnailChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      setThumbnail(e.target.files[0]);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUploadId(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("title", title);
      formData.append("description", description);
      if (summary) formData.append("summary", summary);
      if (publisher) formData.append("publisher", publisher);
      if (tags) formData.append("tags", tags);
      for (const file of files) {
        formData.append("files", file);
      }
      if (thumbnail) {
        formData.append("thumbnail", thumbnail);
      }

      const res = await fetch(`${SERVER_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setUploadId(data.upload_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", padding: "0 1rem", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>
        Upload Test
      </h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Uploads go to R2 → RabbitMQ queue → Rust worker embeds via Gemini → DB
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Title *
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. NGO Survey: Rural Education 2024"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Description *
          <textarea
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Full description of the dataset..."
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Summary
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Short one-line summary"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Publisher
          <input
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            placeholder="e.g. Ministry of Education"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Tags (comma-separated)
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="education, survey, rural"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Thumbnail (optional)
          <input
            type="file"
            accept="image/*"
            onChange={handleThumbnailChange}
          />
          {thumbnail && (
            <span style={{ fontSize: "0.875rem", color: "#555" }}>
              Selected: {thumbnail.name}
            </span>
          )}
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          Attachments *
          <input
            type="file"
            multiple
            required
            onChange={handleFileChange}
            accept=".pdf,.csv,.json,.xlsx,.xls"
          />
          {files.length > 0 && (
            <span style={{ fontSize: "0.875rem", color: "#555" }}>
              {files.length} file(s): {files.map((f) => f.name).join(", ")}
            </span>
          )}
        </label>

        {error && (
          <div style={{ padding: "0.75rem", background: "#fee", border: "1px solid #fca", borderRadius: 6, color: "#c00" }}>
            Error: {error}
          </div>
        )}

        {uploadId && (
          <div style={{ padding: "0.75rem", background: "#efe", border: "1px solid #8c8", borderRadius: 6, color: "#060" }}>
            Queued! upload_id: <strong>{uploadId}</strong>
            <br />
            <span style={{ fontSize: "0.875rem" }}>
              Worker will process this and insert into DB.
            </span>
          </div>
        )}

        <button
          type="submit"
          disabled={uploading}
          style={{
            padding: "0.75rem",
            background: uploading ? "#ccc" : "#111",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: uploading ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.5rem",
  border: "1px solid #ccc",
  borderRadius: 6,
  fontSize: "0.9rem",
};
