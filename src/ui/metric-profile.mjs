import {validateMetricLayoutProfile} from '../map/metric-layout.mjs';

/** Never look for private profiles on a published site or a remote host. */
export async function loadLocalMetricProfile({hostname,fetchProfile}){
  if(!['localhost','127.0.0.1','[::1]','::1'].includes(hostname))return {profile:null,state:'public'};
  const response=await fetchProfile('private/metric-layout-profile.json',{cache:'no-store'});
  if(response.status===404)return {profile:null,state:'missing'};
  if(!response.ok)throw new Error('縮尺プロファイルを読み込めませんでした（'+response.status+'）。');
  const profile=await response.json();validateMetricLayoutProfile(profile);
  return {profile,state:'private'};
}
