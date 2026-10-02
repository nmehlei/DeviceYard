import '@testing-library/jest-dom';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {EditionCard} from '../src/components/EditionCard';
const state={edition:'community',state:'community',multiDevice:false,selectedDeviceId:'a'};
afterEach(()=>jest.restoreAllMocks());
test('shows Community selection and keeps error visible when server refuses a busy switch',async()=>{
  const fetcher=jest.fn().mockResolvedValueOnce({ok:true,status:200,json:async()=>state}).mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:'DEVICE_BUSY'})});
  global.fetch=fetcher;
  render(<EditionCard admin devices={[{id:'a',label:'Phone A'},{id:'b',label:'Phone B'}]} />);
  await screen.findByText('Community');fireEvent.change(screen.getByLabelText('Community device'),{target:{value:'b'}});
  fireEvent.click(screen.getByRole('button',{name:'Select device'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('DEVICE_BUSY');
});
test('read-only users cannot select devices or upload licenses',async()=>{
  global.fetch=jest.fn().mockResolvedValue({ok:true,status:200,json:async()=>({...state,edition:'pro',state:'grace',multiDevice:true,graceEndsAt:1800000000000})});
  render(<EditionCard admin={false} devices={[]} />);
  await screen.findByText('Pro');expect(screen.queryByRole('button',{name:'Select device'})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Pro license file')).not.toBeInTheDocument();
});
test('legacy servers without edition endpoint keep existing UI unchanged',async()=>{
  global.fetch=jest.fn().mockResolvedValue({ok:false,status:404});
  const {container}=render(<EditionCard admin devices={[]} />);
  await waitFor(()=>expect(global.fetch).toHaveBeenCalled());expect(container).toBeEmptyDOMElement();
});
