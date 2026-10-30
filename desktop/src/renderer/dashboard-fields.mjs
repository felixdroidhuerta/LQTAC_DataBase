import {fieldLabel} from './dashboard-model.mjs';
// Resolve presentation labels through combined sources without changing stored names or indices.
export function fieldInfo(board,dataset,index,seen=new Set()){
 const fallback={column:index,label:fieldLabel(dataset,index),group:dataset.name,full:fieldLabel(dataset,index)};if(seen.has(dataset.id))return fallback;seen=new Set(seen);seen.add(dataset.id);
 if(dataset.calculations?.some(c=>c.index===index))return {...fallback,group:'Campos calculados'};
 if(dataset.source?.kind!=='relationship')return fallback;
 let offset=0;for(const id of dataset.source.parents||[]){const parent=board.datasets.find(d=>d.id===id);if(!parent)break;if(index<offset+parent.columns.length){const info=fieldInfo(board,parent,index-offset,seen);return {...info,column:index,full:dataset.columns[index]};}offset+=parent.columns.length;}
 const value=dataset.columns[index]||'',dot=value.lastIndexOf('.');return dot>0?{column:index,label:value.slice(dot+1),group:value.slice(0,dot),full:value}:fallback;
}
export function reorderColumns(columns,column,before=null){const next=columns.filter(i=>i!==column),at=before===null?-1:next.indexOf(before);if(column===before)return [...columns];next.splice(at<0?next.length:at,0,column);return next;}
