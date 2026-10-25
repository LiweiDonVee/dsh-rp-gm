import {fail} from './core.mjs';

/** Launch sources are retained library provenance; Database owns the current binding. */
export async function validateInitialSources(database,sources,signal){
  for(const {databaseId,version}of sources){
    const unavailable=()=>fail('RESTORE_REQUIREMENT_MISSING',`Initial source version is unavailable: ${databaseId}@${version}`,409);
    if(typeof database.database!=='function')unavailable();let value;
    try{value=await database.database({databaseId,version,signal});}catch(error){if(['NOT_FOUND','DATABASE_NOT_FOUND','VERSION_NOT_FOUND'].includes(error.code))unavailable();throw error;}
    if(value.database?.id!==databaseId||value.database.version!==version)unavailable();
  }
}
