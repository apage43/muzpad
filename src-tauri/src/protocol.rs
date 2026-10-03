use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, Read, Write};

pub const VERSION: u32 = 1;
pub const FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const SOURCE_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const SOURCE_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRef { pub project: String, pub epoch: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub protocol_version: u32,
    pub request_id: String,
    pub project: Option<ProjectRef>,
    pub engine_epoch: Option<String>,
    pub source_version: Option<u64>,
    pub revision: Option<String>,
}
impl Context {
    pub fn host(epoch: Option<String>, project: Option<ProjectRef>) -> Self {
        Self { protocol_version: VERSION, request_id: uuid::Uuid::new_v4().to_string(), project,
            engine_epoch: epoch, source_version: None, revision: None }
    }
    pub fn validate(&self) -> Result<(), Failure> {
        if self.protocol_version != VERSION { return Err(Failure::new("protocol_mismatch", "engine", "Unsupported protocol version")); }
        if self.request_id.is_empty() || self.request_id.len() > 128
            || self.source_version.is_some_and(|v| v > MAX_SAFE_INTEGER)
            || self.engine_epoch.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128)
            || self.revision.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128)
            || self.project.as_ref().is_some_and(|p| p.project.is_empty() || p.epoch.is_empty() || p.project.len() > 128 || p.epoch.len() > 128)
        { return Err(Failure::new("stale_request", "engine", "Invalid request identity")); }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String, pub phase: String, pub message: String, pub continuity: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub help: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub callers: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub revision: Option<String>,
}
impl Failure {
    pub fn new(code: impl Into<String>, phase: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), phase: phase.into(), message: message.into(), continuity: "preserved".into(),
            help: None, location: None, callers: None, path: None, request_id: None, revision: None }
    }
    pub fn lost(mut self) -> Self { self.continuity = "lost".into(); self }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for Failure {}
impl From<io::Error> for Failure {
    fn from(e: io::Error) -> Self {
        Self::new(if e.kind() == io::ErrorKind::PermissionDenied { "permission_denied" } else { "file_write_failed" }, "project", e.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateRequest { #[serde(flatten)] pub context: Context, pub command: String, pub args: Value }

// Large source operations keep the same identities and use bounded private frames.
pub fn send_frames(value: Value, mut send: impl FnMut(Value) -> Result<(),Failure>) -> Result<(),Failure> {
    use base64::Engine;
    let bytes=serde_json::to_vec(&value).map_err(|e|Failure::new("protocol_mismatch","engine",e.to_string()))?;
    if bytes.len()<=FRAME_BYTES { return send(value); }
    if bytes.len()>SOURCE_SNAPSHOT_BYTES { return Err(Failure::new("too_large","engine","Private transfer exceeds 64 MiB")); }
    let context=Context::deserialize(&value).map_err(|e|Failure::new("protocol_mismatch","engine",e.to_string()))?;
    for (index,chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        let mut frame=serde_json::to_value(&context).expect("context serializes");
        frame["transferChunk"]=json!({"index":index,"bytes":bytes.len(),"data":base64::engine::general_purpose::STANDARD.encode(chunk)});
        send(frame)?;
    }
    Ok(())
}
struct PartialFrame { context:Context, bytes:Vec<u8>, total:usize, next:usize, updated:std::time::Instant }
#[derive(Default)]
pub struct FrameTransfers { pending:std::collections::HashMap<String,PartialFrame> }
impl FrameTransfers {
    pub fn receive(&mut self,value:Value)->Result<Option<Value>,Failure> {
        use base64::Engine;
        let Some(chunk)=value.get("transferChunk") else { return Ok(Some(value)); };
        let invalid=||Failure::new("protocol_mismatch","engine","Invalid private transfer chunk");
        let context=Context::deserialize(&value).map_err(|_|invalid())?;
        context.validate()?;
        let index=chunk["index"].as_u64().and_then(|v|usize::try_from(v).ok()).ok_or_else(invalid)?;
        let total=chunk["bytes"].as_u64().and_then(|v|usize::try_from(v).ok()).filter(|v|*v>FRAME_BYTES&&*v<=SOURCE_SNAPSHOT_BYTES).ok_or_else(invalid)?;
        let encoded=chunk["data"].as_str().filter(|s|s.len()<=CHUNK_BYTES.div_ceil(3)*4).ok_or_else(invalid)?;
        let bytes=base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|invalid())?;
        if bytes.is_empty()||bytes.len()>CHUNK_BYTES {return Err(invalid());}
        self.pending.retain(|_,partial|partial.updated.elapsed()<std::time::Duration::from_secs(120));
        if index==0 {
            if self.pending.contains_key(&context.request_id)||self.pending.len()>=8
                || self.pending.values().map(|p|p.total).sum::<usize>()+total>SOURCE_SNAPSHOT_BYTES {
                return Err(Failure::new("resource_budget","engine","Private transfer budget exceeded"));
            }
            self.pending.insert(context.request_id.clone(),PartialFrame{context:context.clone(),bytes:Vec::new(),total,next:0,updated:std::time::Instant::now()});
        }
        let partial=self.pending.get_mut(&context.request_id).ok_or_else(invalid)?;
        if partial.context!=context||partial.total!=total||partial.next!=index||partial.bytes.len()+bytes.len()>total {
            self.pending.remove(&context.request_id);return Err(invalid());
        }
        partial.bytes.extend_from_slice(&bytes);partial.next+=1;partial.updated=std::time::Instant::now();
        if partial.bytes.len()!=total {return Ok(None);}
        let partial=self.pending.remove(&context.request_id).expect("transfer present");
        let complete:Value=serde_json::from_slice(&partial.bytes).map_err(|_|invalid())?;
        if Context::deserialize(&complete).ok().as_ref()!=Some(&context)||complete.get("transferChunk").is_some() {return Err(invalid());}
        Ok(Some(complete))
    }
}

pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match reader.read(&mut header[..1]) { Ok(0) => return Ok(None), Ok(_) => (), Err(e) if e.kind() == io::ErrorKind::Interrupted => return read_frame(reader), Err(e) => return Err(e) }
    reader.read_exact(&mut header[1..])?;
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > FRAME_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid private frame size")); }
    let mut bytes = vec![0; size]; reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
pub fn write_frame<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    write_encoded_frame(writer,&bytes)
}
pub fn write_encoded_frame<W:Write>(writer:&mut W,bytes:&[u8])->io::Result<()>{
    if bytes.is_empty() || bytes.len() > FRAME_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Private frame exceeds negotiated limit")); }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?; writer.flush()
}
pub fn reply(context: &Context, result: Result<Value, Failure>) -> Value {
    let mut v = serde_json::to_value(context).expect("context serializes");
    match result { Ok(value) => { v["ok"] = json!(true); v["value"] = value; }, Err(mut failure) => {
        failure.request_id = Some(context.request_id.clone()); v["ok"] = json!(false); v["failure"] = json!(failure);
    } } v
}
pub fn event(context: &Context, sequence: u64, scope: &str, value: Value) -> Value {
    let mut v = serde_json::to_value(context).expect("context serializes");
    v["sequence"] = json!(sequence.to_string()); v["event"] = json!({"scope":scope,"value":value}); v
}
pub fn limits() -> Value {
    json!({"frameBytes":FRAME_BYTES,"sourceChunkBytes":CHUNK_BYTES,"sourceDocumentBytes":SOURCE_DOCUMENT_BYTES,
        "sourceSnapshotBytes":SOURCE_SNAPSHOT_BYTES,"outstandingRequests":64,"preparingCandidates":1,"queuedCandidates":1,
        "inspectionRows":1000,"inspectionBytes":1048576,"statusHz":20,"analysisHz":10,"waveformSamples":2048,
        "spectrumBins":1024,"trackMeters":1000,"analysisBytes":131072,"exportWorkers":2,"exportQueue":32,
        "playableSnapshotBytes":268435456})
}
pub fn capabilities(_epoch: &str) -> Value {
    json!({"environment":"desktop","platform":std::env::consts::OS,"coreRevision":env!("MUZPAD_CORE_REVISION"),
        "protocolVersion":VERSION,"nativePluginFormats":["clap","vst3"],
        "audio":{"available":false,"reason":"Native audio opens when the first revision is prepared","configuration":null},
        "filesystem":{"folder":{"available":true,"reason":null},"watch":{"available":true,"reason":null},
        "reveal":{"available":true,"reason":null},"recovery":{"available":true,"reason":null},"nativeDialogs":{"available":true,"reason":null}},
        "pluginConfig":null,"limits":limits()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn roundtrip_and_clean_eof() {
        let mut bytes = Vec::new(); write_frame(&mut bytes, &json!({"text":"λ\n"})).unwrap();
        let mut stream = bytes.as_slice(); assert_eq!(read_frame(&mut stream).unwrap(), Some(json!({"text":"λ\n"}))); assert!(read_frame(&mut stream).unwrap().is_none());
    }
    #[test] fn rejects_large_truncated_and_non_json_frames() {
        assert!(read_frame(&mut ((FRAME_BYTES as u32 + 1).to_le_bytes().as_slice())).is_err());
        assert!(read_frame(&mut [1u8,0].as_slice()).is_err());
        assert!(read_frame(&mut [1u8,0,0,0,b'x'].as_slice()).is_err());
        let mut output=Vec::new();
        assert!(write_encoded_frame(&mut output,&vec![b'x';FRAME_BYTES+1]).is_err());
        assert!(output.is_empty());
    }
    #[test]
    fn large_format_request_and_reply_use_bounded_identity_preserving_frames() {
        let context=Context::host(Some("engine".into()),None);
        let source=format!("// {}\nlet a=1;\n","λ".repeat(FRAME_BYTES));
        let request=json!(PrivateRequest{context:context.clone(),command:"format".into(),args:json!({"source":source,"path":"main.muz","bufferVersion":42})});
        let mut transfer=FrameTransfers::default();let mut complete=None;let mut count=0;
        send_frames(request.clone(),|frame|{
            let mut wire=Vec::new();write_frame(&mut wire,&frame).unwrap();
            assert!(wire.len()<=FRAME_BYTES+4);count+=1;
            complete=transfer.receive(read_frame(&mut wire.as_slice()).unwrap().unwrap())?;
            Ok(())
        }).unwrap();
        assert!(count>1);assert_eq!(complete,Some(request));
        let formatted=muz::lang::format::format(&source).unwrap();
        let reply=reply(&context,Ok(json!({"bufferVersion":42,"source":formatted})));
        send_frames(reply.clone(),|frame|{complete=transfer.receive(frame)?;Ok(())}).unwrap();
        assert_eq!(complete,Some(reply));
        assert!(transfer.pending.is_empty());
    }
    #[test]
    fn private_transfer_rejects_out_of_order_and_changed_context() {
        let context=Context::host(Some("engine".into()),None);
        let reply=reply(&context,Ok(json!({"source":"x".repeat(FRAME_BYTES+1)})));
        let mut frames=Vec::new();send_frames(reply,|frame|{frames.push(frame);Ok(())}).unwrap();
        assert!(FrameTransfers::default().receive(frames[1].clone()).is_err());
        let mut transfer=FrameTransfers::default();transfer.receive(frames[0].clone()).unwrap();
        frames[1]["sourceVersion"]=json!(7);
        assert!(transfer.receive(frames[1].clone()).is_err());
        assert!(transfer.pending.is_empty());
    }
}
