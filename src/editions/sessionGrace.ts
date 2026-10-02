/** A bounded drain window for existing interactive sessions, never renewed by messages. */
export class SessionGrace {
  private unavailableSince?:number;
  constructor(private readonly now:()=>number=Date.now) {}
  check(allowed:boolean):'allowed'|'warn'|'draining'|'close' {
    if(allowed){this.unavailableSince=undefined;return 'allowed';}
    const time=this.now();
    if(this.unavailableSince===undefined){this.unavailableSince=time;return 'warn';}
    return time-this.unavailableSince>=300000?'close':'draining';
  }
}
