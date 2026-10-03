use crate::protocol::{CHUNK_BYTES, Context, Failure, FRAME_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::HashMap, time::{Duration, Instant}};

const TTL: Duration = Duration::from_secs(120);
const MAX_ITEMS: usize = 8;
// Encoded import JSON includes base64 for up to 256 MiB of assets plus source.
// Dispatch independently enforces the smaller decoded source/document budgets.
const MAX_BYTES: usize = 512 * 1024 * 1024;
struct Upload { context: Context, expected: usize, data: Vec<u8>, index: usize, finished: bool, touched: Instant }
struct Download { context: Context, data: Vec<u8>, touched: Instant }
#[derive(Default)]
pub struct Transfers { uploads: HashMap<String, Upload>, downloads: HashMap<String, Download> }
fn bad(message: &str) -> Failure { Failure::new("stale_request", "project", message) }
impl Transfers {
    fn expire(&mut self) { self.uploads.retain(|_,v| v.touched.elapsed()<TTL); self.downloads.retain(|_,v| v.touched.elapsed()<TTL); }
    fn reserve(&mut self, bytes: usize) -> Result<(), Failure> {
        self.expire();
        let retained = self.uploads.values().map(|v|v.expected).sum::<usize>() + self.downloads.values().map(|v|v.data.len()).sum::<usize>();
        if bytes>MAX_BYTES || self.uploads.len()+self.downloads.len()>=MAX_ITEMS || retained.checked_add(bytes).is_none_or(|n|n>MAX_BYTES) {
            return Err(Failure::new("resource_budget","project","Transfer storage budget exceeded; release previous transfers"));
        } Ok(())
    }
    pub fn begin(&mut self, context: Context, bytes: usize) -> Result<Value, Failure> {
        if bytes==0 { return Err(bad("Empty JSON upload")); } self.reserve(bytes)?;
        let id=uuid::Uuid::new_v4().to_string();
        self.uploads.insert(id.clone(),Upload{context,expected:bytes,data:Vec::new(),index:0,finished:false,touched:Instant::now()}); Ok(json!({"id":id}))
    }
    pub fn chunk(&mut self, context: &Context, id: &str, index: usize, data: &str) -> Result<Value,Failure> {
        self.expire(); let upload=self.uploads.get_mut(id).ok_or_else(||bad("Unknown or expired upload"))?;
        if &upload.context!=context || upload.finished || upload.index!=index || data.len()>CHUNK_BYTES.div_ceil(3)*4 { return Err(bad("Upload ownership, order, or chunk size mismatch")); }
        let bytes=STANDARD.decode(data).map_err(|_|bad("Invalid base64 upload"))?;
        if bytes.len()>CHUNK_BYTES || upload.data.len()+bytes.len()>upload.expected { return Err(bad("Upload exceeds announced size")); }
        upload.data.extend_from_slice(&bytes);upload.index+=1;upload.touched=Instant::now(); Ok(json!({"next":upload.index}))
    }
    pub fn finish(&mut self, context:&Context,id:&str)->Result<Value,Failure>{
        self.expire();let upload=self.uploads.get_mut(id).ok_or_else(||bad("Unknown upload"))?;
        if &upload.context!=context || upload.finished || upload.data.len()!=upload.expected{return Err(bad("Incomplete or foreign upload"));}
        serde_json::from_slice::<Value>(&upload.data).map_err(|_|bad("Upload must contain UTF-8 JSON"))?;
        upload.finished=true;upload.touched=Instant::now();Ok(json!({"id":id}))
    }
    pub fn discard(&mut self,context:&Context,id:&str)->Result<Value,Failure>{
        if let Some(upload)=self.uploads.get(id){if &upload.context!=context{return Err(bad("Foreign upload"));}}
        self.uploads.remove(id);Ok(Value::Null)
    }
    pub fn consume(&mut self,context:&Context,id:&str)->Result<Value,Failure>{
        self.expire();let upload=self.uploads.get(id).ok_or_else(||bad("Unknown upload"))?;
        if &upload.context!=context || !upload.finished{return Err(bad("Unfinished or foreign upload"));}
        let upload=self.uploads.remove(id).expect("checked upload");serde_json::from_slice(&upload.data).map_err(|_|bad("Invalid upload JSON"))
    }
    pub fn outgoing(&mut self,context:&Context,value:Value)->Result<Value,Failure>{
        let bytes=serde_json::to_vec(&value).map_err(|e|bad(&e.to_string()))?;
        if bytes.len()<FRAME_BYTES-16384{return Ok(value);} self.reserve(bytes.len())?;
        let id=uuid::Uuid::new_v4().to_string();let length=bytes.len();
        self.downloads.insert(id.clone(),Download{context:context.clone(),data:bytes,touched:Instant::now()});
        Ok(json!({"transfer":{"id":id,"bytes":length,"chunks":length.div_ceil(CHUNK_BYTES)}}))
    }
    fn owns(owner:&Context,context:&Context)->bool{owner.project==context.project && owner.engine_epoch==context.engine_epoch}
    pub fn read(&mut self,context:&Context,id:&str,index:usize)->Result<Value,Failure>{
        self.expire();let v=self.downloads.get_mut(id).ok_or_else(||bad("Unknown or expired transfer"))?;
        if !Self::owns(&v.context,context){return Err(bad("Transfer belongs to an obsolete context"));}
        let start=index.checked_mul(CHUNK_BYTES).filter(|s|*s<v.data.len()).ok_or_else(||bad("Invalid transfer chunk"))?;
        let end=(start+CHUNK_BYTES).min(v.data.len());v.touched=Instant::now();
        Ok(json!({"index":index,"data":STANDARD.encode(&v.data[start..end]),"last":end==v.data.len()}))
    }
    pub fn release(&mut self,context:&Context,id:&str)->Result<Value,Failure>{
        if let Some(v)=self.downloads.get(id){if !Self::owns(&v.context,context){return Err(bad("Foreign transfer"));}}
        self.downloads.remove(id);Ok(Value::Null)
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn uploads_are_ordered_complete_and_single_use(){
        let c=Context::host(None,None);let mut t=Transfers::default();let id=t.begin(c.clone(),4).unwrap()["id"].as_str().unwrap().to_string();
        assert!(t.chunk(&c,&id,1,"bnVsbA==").is_err()); t.chunk(&c,&id,0,"bnVsbA==").unwrap();t.finish(&c,&id).unwrap();
        assert_eq!(t.consume(&c,&id).unwrap(),Value::Null);assert!(t.consume(&c,&id).is_err());
    }
    #[test] fn ownership_and_limits_are_enforced_before_allocation(){
        let owner=Context::host(Some("engine-a".into()),None);
        let mut t=Transfers::default();
        assert!(t.begin(owner.clone(),MAX_BYTES+1).is_err());
        let id=t.begin(owner.clone(),4).unwrap()["id"].as_str().unwrap().to_owned();
        let other=Context::host(Some("engine-a".into()),None);
        assert!(t.chunk(&other,&id,0,"bnVsbA==").is_err());
        assert!(t.finish(&owner,&id).is_err());
        t.discard(&owner,&id).unwrap();
        assert!(t.finish(&owner,&id).is_err());
    }
    #[test] fn download_reads_bind_epoch_not_read_request_id(){
        let owner=Context::host(Some("engine-a".into()),None);
        let mut t=Transfers::default();
        let value=json!({"text":"x".repeat(FRAME_BYTES)});
        let descriptor=t.outgoing(&owner,value).unwrap();
        let id=descriptor["transfer"]["id"].as_str().unwrap();
        let reader=Context::host(Some("engine-a".into()),None);
        assert_eq!(t.read(&reader,id,0).unwrap()["index"],0);
        let stale=Context::host(Some("engine-b".into()),None);
        assert!(t.read(&stale,id,0).is_err());
        t.release(&reader,id).unwrap();
        assert!(t.read(&reader,id,0).is_err());
    }
}
