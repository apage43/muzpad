#![cfg(target_os = "linux")]
pub mod engine;
pub mod protocol;
#[cfg(feature = "shell")]
mod host;
#[cfg(feature = "shell")]
mod project;
#[cfg(feature = "shell")]
mod supervisor;
#[cfg(feature = "shell")]
mod transfers;

#[cfg(feature = "shell")]
mod shell {
use crate::host::{Host,Request};
use crate::protocol::{Context,Failure};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager,State,WebviewWindow};

fn trusted(window:&WebviewWindow)->Result<(),Failure>{
    let url=window.url().map_err(|e|Failure::new("denied_path","engine",e.to_string()))?;
    if window.label()!="main"||!trusted_url(&url){return Err(Failure::new("denied_path","engine","Native commands are restricted to the bundled workbench"));}Ok(())
}
fn trusted_url(url:&url::Url)->bool{(url.scheme()=="tauri"&&url.host_str()==Some("localhost"))||(url.scheme()=="http"&&url.host_str()==Some("tauri.localhost"))}
async fn blocking<T:Send+'static>(f:impl FnOnce()->Result<T,Failure>+Send+'static)->Result<T,Failure>{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e|Failure::new("child_died","engine",format!("Host task failed: {e}")))?
}
#[tauri::command]
async fn workbench_bootstrap(window:WebviewWindow,state:State<'_,Arc<Host>>)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.bootstrap()).await}
#[tauri::command]
async fn workbench_request(window:WebviewWindow,state:State<'_,Arc<Host>>,request:Request)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||Ok(host.request(request))).await}
#[tauri::command]
async fn workbench_cancel(window:WebviewWindow,state:State<'_,Arc<Host>>,context:Context,target:String)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.cancel(&context,&target)).await}
#[tauri::command]
async fn workbench_upload_begin(window:WebviewWindow,state:State<'_,Arc<Host>>,context:Context,purpose:String,bytes:usize)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.upload_begin(context,&purpose,bytes)).await}
#[tauri::command]
async fn workbench_upload_chunk(window:WebviewWindow,state:State<'_,Arc<Host>>,context:Context,id:String,index:usize,data:String)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.upload_chunk(&context,&id,index,&data)).await}
#[tauri::command]
async fn workbench_upload_finish(window:WebviewWindow,state:State<'_,Arc<Host>>,context:Context,id:String)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.upload_finish(&context,&id)).await}
#[tauri::command]
async fn workbench_upload_discard(window:WebviewWindow,state:State<'_,Arc<Host>>,context:Context,id:String)->Result<Value,Failure>{trusted(&window)?;let host=state.inner().clone();blocking(move||host.upload_discard(&context,&id)).await}

pub fn run(){
    let app=tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,_args,_cwd|{if let Some(window)=app.get_webview_window("main"){let _=window.unminimize();let _=window.show();let _=window.set_focus();}}))
        .invoke_handler(tauri::generate_handler![workbench_bootstrap,workbench_request,workbench_cancel,workbench_upload_begin,workbench_upload_chunk,workbench_upload_finish,workbench_upload_discard])
        .setup(|app|{
            let host=Host::new(app.handle().clone())?;app.manage(host.clone());
            let window=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
                .title("muzpad").inner_size(1400.,900.).min_inner_size(480.,320.)
                .on_navigation(trusted_url)
                .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
                .build()?;
            window.on_window_event(move|event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{if !host.is_disposed(){api.prevent_close();host.request_close("closeWindow");}}});
            Ok(())
        }).build(tauri::generate_context!()).expect("Cannot initialize the trusted native workbench");
    app.run(|handle,event|match event{
        tauri::RunEvent::ExitRequested{api,..}=>{let host=handle.state::<Arc<Host>>();if !host.is_disposed(){api.prevent_exit();host.request_close("quit");}},
        tauri::RunEvent::Exit=>{let host=handle.state::<Arc<Host>>();let _=host.shutdown();},_=>()
    });
}
}

#[cfg(feature = "shell")]
pub use shell::run;
